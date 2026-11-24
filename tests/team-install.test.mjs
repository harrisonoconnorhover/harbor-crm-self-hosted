import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('team init binds credentials to a validated origin and preserves them on retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harbor-team-init-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  function run(program, ...args) {
    return spawnSync(program, args, {cwd: root, encoding: 'utf8'});
  }
  await mkdir(join(root, 'scripts'));
  await copyFile(new URL('../scripts/team-install.sh', import.meta.url), join(root, 'scripts/team-install.sh'));
  assert.equal(run('git', 'init', '--quiet').status, 0);
  assert.equal(run('git', '-c', 'user.name=Harbor', '-c', 'user.email=harbor@example.test', 'commit', '--allow-empty', '-qm', 'Fictional setup').status, 0);
  const init = host => run('sh', 'scripts/team-install.sh', 'init', host);
  const config = name => join(root, '.harbor/team', name);
  for (const badHost of ['https://crm.example.test', 'crm.example.test\nextra', 'crm.example.test/']) {
    assert.equal(init(badHost).status, 2);
  }
  assert.equal(init('crm.example.test').status, 0);
  const web = await readFile(config('web.env'), 'utf8');
  assert.match(web, /^HARBOR_LOGIN_ORIGIN=https:\/\/crm\.example\.test$/m);
  assert.match(web, /^DATABASE_URL=postgresql:\/\/harbor:[a-f0-9]{64}@postgres:5432\/harbor$/m);
  const [account] = JSON.parse(await readFile(config('s3.json'), 'utf8')).identities;
  assert.deepEqual(account.actions, ['Read:harbor-files', 'List:harbor-files', 'Write:harbor-files']);
  assert.ok(web.includes('HARBOR_S3_SECRET_ACCESS_KEY=' + account.credentials[0].secretKey + '\n'));
  assert.equal((await stat(config('s3.json'))).mode & 0o077, 0);
  assert.equal(init('different.example.test').status, 1);
  assert.equal(await readFile(config('web.env'), 'utf8'), web);
});
