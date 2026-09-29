// DEMO=1: a public, read-only showcase of the dashboard with invented data.
//
// Three made-up apps, sixty days of plausible usage and a handful of feedback
// threads, generated from a fixed seed (stable screenshots) and re-generated
// every day so "last event" never goes stale. In this mode the server opens
// /admin reads without a token, refuses every admin write, and closes /v1, so
// no app can ever send real data to a demo.
//
// Seeding wipes the database first. It refuses to run against one that holds
// any write key: a real instance always has one, a demo never mints any. That
// is the line between "reset the showcase" and "delete someone's data".
import { log } from './config.mjs';
import { q, tx } from './db.mjs';

export const DEMO_APPS = [
  { slug: 'stillwater', name: 'Stillwater', installs: 900, highlight: 'meditation_completed', events: ['meditation_started', 'meditation_completed', 'streak_viewed', 'reminder_set'] },
  { slug: 'tally', name: 'Tally', installs: 460, highlight: 'habit_checked', events: ['habit_created', 'habit_checked', 'stats_viewed', 'reminder_set'] },
  { slug: 'pace', name: 'Pace', installs: 230, highlight: 'run_finished', events: ['run_started', 'run_finished', 'route_saved'] },
];

/** The catalog a demo runs with when no CATALOG_FILE is given. */
export const DEMO_CATALOG = Object.fromEntries(
  DEMO_APPS.map((a) => [a.slug, { events: a.events, highlight: { event: a.highlight, doneProp: 'completed' } }]),
);

// A small seeded PRNG (mulberry32): the same showcase every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, items) => items[Math.floor(r() * items.length)];
const weighted = (r, pairs) => {
  const total = pairs.reduce((n, [, w]) => n + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) if ((x -= w) < 0) return v;
  return pairs[pairs.length - 1][0];
};
const uuid = (r) =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = Math.floor(r() * 16);
    return (c === 'x' ? n : (n & 0x3) | 0x8).toString(16);
  });

const COUNTRIES = [['US', 30], ['DE', 16], ['GB', 12], ['FR', 8], ['NL', 6], ['CA', 6], ['AU', 5], ['DK', 4], ['ES', 4], ['SE', 3], ['IT', 3], ['JP', 3]];
const LOCALE = { US: 'en-US', DE: 'de-DE', GB: 'en-GB', FR: 'fr-FR', NL: 'nl-NL', CA: 'en-CA', AU: 'en-AU', DK: 'da-DK', ES: 'es-ES', SE: 'sv-SE', IT: 'it-IT', JP: 'ja-JP' };
const VERSIONS = [['1.4.0', 55], ['1.3.2', 25], ['1.3.1', 12], ['1.2.0', 8]];
const DEVICES = { ios: ['iPhone17,1', 'iPhone16,2', 'iPhone15,3', 'iPhone14,5'], android: ['Pixel 8', 'SM-S921B', 'Pixel 7a', 'CPH2581'] };

const TICKETS = [
  { app: 'stillwater', kind: 'issue', subject: 'Timer stops when the screen locks', message: 'On my iPhone the session timer freezes as soon as I lock the screen. The bell never rings.', email: 'sam@example.com', replies: [['support', 'Thanks for the report. 1.4.0 keeps the timer running while locked; could you update and tell me if it works?'], ['user', 'Updated, works perfectly now. Thank you!']], status: 'closed', daysAgo: 12 },
  { app: 'stillwater', kind: 'feature', subject: 'Sleep sounds after a session', message: 'Would love an option to keep rain sounds playing after the meditation ends, so I can fall asleep to it.', replies: [], status: 'open', daysAgo: 2 },
  { app: 'stillwater', kind: 'love', subject: null, message: 'Day 40 in a row. This app changed my mornings. Thank you for making it without ads.', replies: [['support', 'That made our week. Thank you for writing!']], status: 'answered', daysAgo: 5 },
  { app: 'stillwater', kind: 'issue', subject: 'Restore purchase', message: 'I bought Pro on my old phone. How do I get it on the new one?', email: 'lena@example.com', replies: [['support', 'Open Settings and tap Restore purchases while signed in with the same Apple ID; Pro comes back right away.']], status: 'answered', daysAgo: 1 },
  { app: 'tally', kind: 'feature', subject: 'Habits every other day', message: 'Some of my habits are every second day. Could the streak count skip the off days?', replies: [['support', 'Good one. Flexible schedules are next on the list.']], status: 'answered', daysAgo: 8 },
  { app: 'tally', kind: 'issue', subject: 'Widget shows yesterday', message: 'The home screen widget still shows yesterday\'s checkmarks until I open the app.', replies: [], status: 'open', daysAgo: 0 },
  { app: 'tally', kind: 'love', subject: null, message: 'Simplest habit app I have tried. Please never add social features :)', replies: [], status: 'open', daysAgo: 3 },
  { app: 'pace', kind: 'issue', subject: 'GPS drift in the city', message: 'Between tall buildings my runs come out 10% too long.', email: 'jo@example.com', replies: [['support', 'We smooth the track more aggressively in 1.4.0. Does it look better on your last run?']], status: 'answered', daysAgo: 4 },
  { app: 'pace', kind: 'feature', subject: 'Apple Watch app', message: 'I would use this every day if I could start a run from my watch.', replies: [], status: 'open', daysAgo: 6 },
];

async function insertRows(client, table, columns, rows) {
  const per = Math.floor(30000 / columns.length);
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params = [];
    const values = chunk.map((row, r) => `(${row.map((v, c) => { params.push(v); return `$${r * columns.length + c + 1}`; }).join(',')})`);
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}`, params);
  }
}

export async function seedDemo() {
  const { rows } = await q('SELECT count(*)::int AS n FROM write_keys');
  if (rows[0].n > 0) {
    throw new Error('DEMO=1 refuses to run: this database has write keys, so it is a real instance. A demo needs its own empty database.');
  }
  const r = rng(20260929);
  const DAY = 86400000;
  const now = Date.now();
  const installs = [];
  const events = [];

  for (const app of DEMO_APPS) {
    for (let i = 0; i < app.installs; i++) {
      // More installs lately: a small app that is growing.
      const ageDays = Math.floor(60 * Math.pow(r(), 1.6));
      const first = now - ageDays * DAY - Math.floor(r() * DAY * 0.9);
      const platform = r() < 0.7 ? 'ios' : 'android';
      const country = weighted(r, COUNTRIES);
      const version = weighted(r, VERSIONS);
      const id = uuid(r);
      const pro = r() < 0.07;
      // How many later days this install comes back: many never, some daily.
      const loyalty = r();
      const returns = loyalty < 0.35 ? 0 : loyalty < 0.7 ? Math.floor(r() * 4) : Math.floor(r() * Math.max(1, ageDays));
      const days = [0, ...Array.from({ length: returns }, () => 1 + Math.floor(r() * Math.max(1, ageDays)))].filter((d) => d <= ageDays);
      let last = first;
      for (const [n, d] of days.sort((a, b) => a - b).entries()) {
        const sessionAt = first + d * DAY + Math.floor(r() * 3600000);
        if (sessionAt > now) continue;
        last = Math.max(last, sessionAt);
        const session = uuid(r);
        const at = (offsetMin) => new Date(Math.min(now, sessionAt + offsetMin * 60000)).toISOString();
        const ev = (name, props = {}, offset = 0) => events.push([uuid(r), app.slug, 'prod', id, session, name, true, at(offset), version, platform, JSON.stringify(props)]);
        if (n === 0) ev('app_first_opened');
        ev('session_started', { entry: weighted(r, [['launch', 80], ['notification', 12], ['widget', 8]]) });
        const screens = 1 + Math.floor(r() * 3);
        for (let s = 0; s < screens; s++) ev('screen_viewed', { screen: pick(r, ['Home', 'Library', 'Stats', 'Settings']) }, s);
        if (r() < 0.8) ev(app.highlight, { completed: r() < 0.74, minutes: 5 + Math.floor(r() * 20) }, 4);
        if (r() < 0.25) ev(pick(r, app.events.filter((e) => e !== app.highlight)), {}, 6);
        if (n === 0 && r() < 0.32) {
          ev('paywall_viewed', { source: pick(r, ['onboarding', 'settings', 'locked_feature']) }, 1);
          if (r() < 0.35) {
            ev('purchase_started', { product: pick(r, ['pro_yearly', 'pro_monthly']) }, 2);
            ev('purchase_result', { result: pro ? 'purchased' : weighted(r, [['cancelled', 70], ['failed', 30]]) }, 3);
          }
        }
        // One name the catalog does not know, so the dashboard's flag shows.
        if (app.slug === 'tally' && r() < 0.05) ev('widget_added', {}, 7);
      }
      installs.push([id, app.slug, 'prod', new Date(first).toISOString(), new Date(last).toISOString(), platform, `${platform} ${platform === 'ios' ? '18.6' : '15'}`, pick(r, DEVICES[platform]), LOCALE[country], country, version, '42', pro]);
    }
  }

  await tx(async (client) => {
    await client.query('TRUNCATE events, installs, ticket_replies, tickets, write_keys, apps CASCADE');
    await insertRows(client, 'apps', ['slug', 'name'], DEMO_APPS.map((a) => [a.slug, a.name]));
    await insertRows(client, 'installs', ['id', 'app', 'env', 'first_seen', 'last_seen', 'platform', 'os', 'device', 'locale', 'country', 'version', 'build', 'pro'], installs);
    // The catalog's known flag is set above from the demo catalog; widget_added is not in it.
    for (const e of events) if (e[5] === 'widget_added') e[6] = false;
    await insertRows(client, 'events', ['id', 'app', 'env', 'install', 'session', 'name', 'known', 'at', 'version', 'platform', 'props'], events);
    for (const t of TICKETS) {
      const created = new Date(now - t.daysAgo * DAY - 3 * 3600000);
      const install = installs.find((i) => i[1] === t.app)[0];
      const { rows: [row] } = await client.query(
        `INSERT INTO tickets (app, install, email, subject, message, diag, kind, status, created_at, updated_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9, $9) RETURNING id`,
        [t.app, install, t.email ?? null, t.subject, t.message, JSON.stringify({ version: '1.4.0', os: 'ios 18.6', pro: false }), t.kind, t.status, created.toISOString()],
      );
      for (const [k, [author, body]] of t.replies.entries()) {
        await client.query('INSERT INTO ticket_replies (ticket_id, author, body, created_at) VALUES ($1, $2, $3, $4)', [row.id, author, body, new Date(created.getTime() + (k + 1) * 5 * 3600000).toISOString()]);
      }
    }
  });
  log.info('demo seeded', { apps: DEMO_APPS.length, installs: installs.length, events: events.length, tickets: TICKETS.length });
}
