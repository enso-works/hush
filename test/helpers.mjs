// Test harness: a real Postgres, a real server process, real HTTP.
//
// Each test file gets its own database, created fresh, and its own server
// started with `node src/server.mjs`, exactly as the container runs it, so
// migrations from empty are exercised on every run. Point
// TEST_DATABASE_URL at any Postgres you can create databases on; the default
// matches the `docker run` line in CONTRIBUTING.md.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@127.0.0.1:55432/postgres';
export const ADMIN_TOKEN = 'test-admin-token';

const withDb = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

export async function freshDatabase(prefix) {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = withDb(ADMIN_URL, name);
  return {
    url,
    async query(text, params) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(text, params);
      } finally {
        await c.end();
      }
    },
    async drop() {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

// A port the OS just handed out, so parallel test files do not collide the
// way random picks did (EADDRINUSE in CI, 2026-09-29).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer(db, env = {}) {
  // Another process can still take the port between freePort() and the
  // server's listen(); a server that dies on EADDRINUSE is simply retried.
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(db, env, await freePort());
    } catch (err) {
      if (attempt >= 5 || !/EADDRINUSE/.test(String(err.message))) throw err;
    }
  }
}

async function startOnce(db, env, port) {
  const logs = [];
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: db.url,
      PORT: String(port),
      ADMIN_TOKEN,
      // The name bavrk's deployment passes; both must keep working.
      TELEMETRY_ADMIN_TOKEN: ADMIN_TOKEN,
      MAIL_DRY_RUN: '1',
      // The harness gives every client its own address in this header; a
      // test that needs the socket address overrides it with ''.
      CLIENT_IP_HEADER: 'cf-connecting-ip',
      // No test reaches bavrk's push relay; relay.test.mjs runs its own.
      PUSH_RELAY: 'off',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** Registers an app and mints a write key for it, the way the CLI does. */
export async function addApp(db, slug, name = slug, env = 'prod') {
  await db.query('INSERT INTO apps (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [slug, name]);
  const key = `bvk_${slug}_${env}_${randomBytes(18).toString('base64url')}`;
  const hash = createHash('sha256').update(key).digest('hex');
  await db.query('INSERT INTO write_keys (app, env, hash, label) VALUES ($1, $2, $3, $4)', [slug, env, hash, 'test']);
  return key;
}

// Every client is its own caller: a random address in the header the rate
// limiter counts by, so tests do not share one limiter bucket by accident.
// (In production that header comes from Cloudflare and nothing else.)
const randomIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}.${randomBytes(2).toString('hex')}`;

export function client(base, key, { ip = randomIp() } = {}) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(key ? { Authorization: key.startsWith('Bearer ') ? key : `Key ${key}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'CF-Connecting-IP': ip,
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, body, headers) => call('POST', path, body, headers),
    delete: (path, body, headers) => call('DELETE', path, body, headers),
  };
}

export const admin = (base) => client(base, `Bearer ${ADMIN_TOKEN}`);

/** An event the way the Expo SDK queues one. */
export const event = (install, name, extra = {}) => ({
  id: randomUUID(),
  name,
  at: new Date().toISOString(),
  session: extra.session ?? randomUUID(),
  install,
  props: extra.props ?? {},
});

/** The batch body the Expo SDK posts to /v1/events. */
export const batch = (events, context = {}) => ({
  sent_at: new Date().toISOString(),
  sdk: '1',
  context: {
    version: '2.0.1',
    build: '15',
    platform: 'ios',
    os: 'ios 18.6',
    device: 'iPhone17,1',
    locale: 'en-US',
    rc_id: null,
    ...context,
  },
  events,
});

export { randomUUID as uuid };
