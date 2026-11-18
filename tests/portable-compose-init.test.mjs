import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('Compose setup writes private settings once and preserves operator edits on rerun', {skip:process.platform === 'win32'}, async context => {
  const checkout = await mkdtemp(join(tmpdir(), 'harbor fresh checkout-'));
  context.after(() => rm(checkout, {recursive:true, force:true}));
  const scripts = join(checkout, 'scripts');
  const script = join(scripts, 'init-portable-compose.sh');
  const settings = join(checkout, '.harbor/compose/web.env');
  await mkdir(scripts);
  await copyFile(new URL('../scripts/init-portable-compose.sh', import.meta.url), script);

  execFileSync('sh', [script], {cwd:tmpdir()});
  assert.equal((await stat(settings)).mode & 0o777, 0o600);
  assert.match(await readFile(settings, 'utf8'), /^DATABASE_URL=$/m);

  const edited = 'HARBOR_LOGIN_ORIGIN=https://crm.example.test\n';
  await writeFile(settings, edited);
  execFileSync('sh', [script], {cwd:tmpdir()});
  assert.equal(await readFile(settings, 'utf8'), edited);
});
