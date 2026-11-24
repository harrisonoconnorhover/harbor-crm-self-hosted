// This entrypoint runs only in the local demo image. It always creates a new,
// private database and bucket; it never reads a host DATABASE_URL or provider key.
import {spawn, execFileSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import postgres from 'postgres';
import S3rver from '@20minutes/s3rver';
import {S3Client, CreateBucketCommand} from '@aws-sdk/client-s3';
import {serveDemo} from './gateway.mjs';
import {seedDemo} from './workspace.mjs';

const host = '127.0.0.1';
const port = Number(process.env.HARBOR_DEMO_PORT || 8793);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8788, 5432, 4569].includes(port)) {
  throw Error('Choose an available demo port from 1024 to 65535 other than 8788, 5432 or 4569.');
}
const origin = 'http://' + host + ':' + port;
const roles = {
  manager: {id: randomUUID(), email: 'morgan@example.test', name: 'Morgan Reed'},
  rep: {id: randomUUID(), email: 'alex@example.test', name: 'Alex Chen'},
};
process.umask(0o077);
const root = await mkdtemp(join(tmpdir(), 'harbor-demo-'));
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
function supervise(binary, args, env) {
  const child = spawn(binary, args, {env, stdio: ['ignore', 'ignore', 'inherit']});
  children.push(child);
  child.once('exit', () => stop(1));
  return child;
}

const binaries = await import('@embedded-postgres/' + process.platform + '-' + process.arch);
const database = join(root, 'postgres');
const password = randomBytes(24).toString('hex');
const pwfile = join(root, 'pwfile');
await writeFile(pwfile, password + '\n');
execFileSync(binaries.initdb, ['-D', database, '--encoding=UTF8', '--username=postgres', '--auth=scram-sha-256', '--pwfile=' + pwfile]);
await rm(pwfile);
supervise(binaries.postgres, ['-D', database, '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='], process.env);
const dbUrl = 'postgres://postgres:' + password + '@127.0.0.1:5432/postgres';
const sql = postgres(dbUrl, {max: 1, connect_timeout: 3});
async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw Error(what + ' did not start.');
}
await waitFor(() => sql`SELECT 1`, 'Demo Postgres');

const store = new S3rver({address: host, port: 4569, directory: join(root, 'files'), silent: true, allowMismatchedSignatures: true});
await store.run();
const endpoint = 'http://127.0.0.1:4569';
const bucket = 'harbor-demo-attachments';
const client = new S3Client({endpoint, forcePathStyle: true, region: 'us-east-1', credentials: {accessKeyId:'S3RVER',secretAccessKey:'S3RVER'}});
await client.send(new CreateBucketCommand({Bucket: bucket}));
client.destroy();

const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production',
  HARBOR_PORTABLE_MODE: 'local', PORT: String(port), DATABASE_URL: dbUrl,
  HARBOR_LOGIN_ORIGIN: origin, HARBOR_LOGIN_ALLOWED_EMAILS: Object.values(roles).map(r => r.email).join(','),
  HARBOR_LOGIN_GOOGLE_CLIENT_ID: 'fictional-local-demo', HARBOR_LOGIN_GOOGLE_CLIENT_SECRET: randomBytes(32).toString('hex'),
  HARBOR_S3_ENDPOINT: endpoint, HARBOR_S3_BUCKET: bucket, HARBOR_S3_REGION: 'us-east-1',
  HARBOR_S3_ACCESS_KEY_ID: 'S3RVER', HARBOR_S3_SECRET_ACCESS_KEY: 'S3RVER',
};
const cli = 'scripts/portable-web.mjs';
execFileSync(process.execPath, [cli, 'migrate'], {env, stdio: 'inherit'});
for (const role of Object.values(roles)) {
  const now = Date.now();
  await sql`INSERT INTO login_identities (id, google_subject, email, full_name, created_at, updated_at)
            VALUES (${role.id}, ${'demo-' + role.id}, ${role.email}, ${role.name}, ${now}, ${now})`;
}
// Only the two fictional accounts created above may receive a session.
async function session(role) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('base64url');
  const now = Date.now();
  await sql`INSERT INTO login_sessions (token_hash, user_id, created_at, expires_at)
            VALUES (${hash}, ${role.id}, ${now}, ${now + 24 * 60 * 60 * 1000})`;
  return token;
}
supervise(process.execPath, [cli, 'start'], env);
await waitFor(async () => (await fetch(origin + '/healthz')).ok, 'Harbor web');
const workspaceId = await seedDemo(origin, roles, session);
serveDemo({origin, port, roles, session, workspaceId});
