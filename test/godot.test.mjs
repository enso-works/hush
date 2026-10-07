// The Godot add-on (godot/addons/hush) against the real server: Godot runs
// godot/tests/run_tests.gd headless, which checks the client's side, and this
// file then checks what the server stored. Skipped when there is no `godot`
// on PATH (or in GODOT), unless REQUIRE_GODOT is set, as CI sets it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { addApp, freshDatabase, startServer } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GODOT = process.env.GODOT || 'godot';
const version = spawnSync(GODOT, ['--version'], { encoding: 'utf8' });
const skip = version.error ? `no ${GODOT} on PATH` : false;
if (skip && process.env.REQUIRE_GODOT) throw new Error(`REQUIRE_GODOT is set and ${skip}`);

let db;
let server;
let storage;
let run;

function runGodot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(GODOT, ['--headless', '--path', join(ROOT, 'godot'), '-s', 'tests/run_tests.gd'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

before(async () => {
  if (skip) return;
  db = await freshDatabase('godot');
  server = await startServer(db);
  const key = await addApp(db, 'mygame', 'My Game');
  storage = mkdtempSync(join(tmpdir(), 'hush-godot-'));
  run = await runGodot({ HUSH_URL: server.base, HUSH_KEY: key, HUSH_STORAGE: storage });
});

after(async () => {
  await server?.stop();
  await db?.drop();
  if (storage) rmSync(storage, { recursive: true, force: true });
});

const result = () => {
  const line = run.out.split('\n').find((l) => l.startsWith('HUSH_RESULT '));
  assert.ok(line, `no HUSH_RESULT line:\n${run.out}`);
  return JSON.parse(line.slice('HUSH_RESULT '.length));
};
const events = async (install) =>
  (await db.query('SELECT name, session, props, channel, platform, version FROM events WHERE install = $1 ORDER BY at, name', [install])).rows;

test('the add-on passes its own checks against the server', { skip }, () => {
  if (process.env.GODOT_LOG) console.log(run.out);
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^0 failed$/m);
});

test('the install is stored as the other SDKs store theirs', { skip }, async () => {
  const { install, platform } = result();
  const { rows } = await db.query('SELECT * FROM installs WHERE id = $1', [install]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.app, 'mygame');
  assert.equal(row.env, 'prod');
  assert.equal(row.sdk, 'godot-0.1.0');
  assert.equal(row.platform, platform);
  assert.match(row.os, new RegExp(`^${platform}( |$)`));
  assert.equal(row.version, '1.2.3', 'Project Settings > Application > Config > Version');
  assert.equal(row.channel, 'dev');
  assert.equal(row.pro, true);
  assert.ok(row.device && row.locale, 'device and locale');
  assert.ok(!row.locale.includes('_'), `locale ${row.locale} as a BCP 47 tag`);
});

test('events, sessions and once-events arrive as tracked', { skip }, async () => {
  const rows = await events(result().install);
  const count = (name) => rows.filter((e) => e.name === name).length;
  assert.equal(count('app_first_opened'), 1);
  assert.equal(count('tutorial_finished'), 1, 'once across two launches');
  assert.deepEqual(rows.filter((e) => e.name === 'level_unlocked').map((e) => e.props.level).sort(), [2, 3]);
  assert.deepEqual(rows.find((e) => e.name === 'tutorial_finished').props, { step: 'done', ratio: null });

  // Both launches run in one process here, so the autoload's launch time comes first: by number.
  const sessions = rows.filter((e) => e.name === 'session_started').sort((a, b) => a.props.n - b.props.n);
  assert.deepEqual(sessions.map((e) => e.props.n), [1, 2, 3]);
  assert.equal(new Set(sessions.map((e) => e.session)).size, 3, 'a session id per session');
  assert.ok(sessions[2].props.prev_fg_s >= 5, `prev_fg_s ${sessions[2].props.prev_fg_s}`);
  assert.equal(sessions[0].props.entry, 'launch');

  assert.deepEqual(rows.find((e) => e.name === 'screen_viewed').props, { screen: 'main_menu', difficulty: 'hard' });
  assert.deepEqual(rows.find((e) => e.name === 'level_completed').props, { level: 3, stars: 2, time_s: 41.5, perfect: false, difficulty: 'hard' });
  assert.equal(count('ticket_opened'), 2, 'the plain ticket and the panel, not the email one');
  assert.equal(count('ticket_replied'), 1, 'the reply by install, not the one by thread key');
  assert.ok(!rows.some((e) => /bad|nested|^x$/i.test(e.name)), 'nothing invalid');
  assert.ok(rows.every((e) => e.channel === 'dev' && e.version === '1.2.3'));
});

test('a ticket with an email carries no install; one without carries it', { skip }, async () => {
  const { install, plain_ticket, email_ticket, panel_ticket } = result();
  const ticket = async (id) => (await db.query('SELECT * FROM tickets WHERE id = $1', [id])).rows[0];

  const plain = await ticket(plain_ticket);
  assert.equal(plain.install, install);
  assert.equal(plain.email, null);
  assert.equal(plain.kind, 'issue');
  assert.equal(plain.subject, 'Bridge');
  assert.equal(plain.diag.version, '1.2.3');
  assert.equal(plain.diag.pro, true);
  assert.ok(plain.diag.os && plain.diag.device);

  const emailed = await ticket(email_ticket);
  assert.equal(emailed.install, null);
  assert.equal(emailed.email, 'player@example.com');
  assert.equal(emailed.kind, 'feature');
  assert.equal(emailed.rc_id, null);
  assert.ok(emailed.thread_hash, 'answered with a thread key');
  assert.ok(!JSON.stringify(emailed.diag).includes(install), 'no install id in its diag');

  const panel = await ticket(panel_ticket);
  assert.equal(panel.kind, 'love');
  assert.equal(panel.install, install);

  const replies = (await db.query("SELECT ticket_id::text AS id FROM ticket_replies WHERE author = 'user' ORDER BY id")).rows.map((r) => r.id);
  assert.deepEqual(replies.sort(), [plain_ticket, email_ticket].sort());

  const linked = await db.query('SELECT count(*)::int AS n FROM tickets WHERE email IS NOT NULL AND install IS NOT NULL');
  assert.equal(linked.rows[0].n, 0);
});

test('an opted-out install sends only what it sent while opted in', { skip }, async () => {
  const rows = await events(result().optout_install);
  assert.deepEqual(rows.map((e) => e.name), ['session_started']);
});

test('forget deletes the install, its events and its email tickets', { skip }, async () => {
  const { forgotten_install, forgotten_ticket, new_install } = result();
  assert.equal((await events(forgotten_install)).length, 0);
  assert.equal((await db.query('SELECT 1 FROM installs WHERE id = $1', [forgotten_install])).rows.length, 0);
  assert.equal((await db.query('SELECT 1 FROM tickets WHERE id = $1', [forgotten_ticket])).rows.length, 0);
  const fresh = await events(new_install);
  assert.deepEqual(fresh.map((e) => [e.name, e.props.n]), [['session_started', 1]]);
});
