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
  { slug: 'stillwater', appStoreId: '6700000101', name: 'Stillwater', installs: 900, start: 'meditation_started', highlight: 'meditation_completed', first: 'First meditation', events: ['onboarding_completed', 'meditation_started', 'meditation_completed', 'streak_viewed', 'reminder_set'] },
  // A habit is created once, then checked off in later sessions.
  { slug: 'tally', appStoreId: '6700000102', name: 'Tally', installs: 460, start: 'habit_created', startOnce: true, highlight: 'habit_checked', first: 'First habit', events: ['onboarding_completed', 'habit_created', 'habit_checked', 'stats_viewed', 'reminder_set'] },
  { slug: 'pace', appStoreId: '6700000103', name: 'Pace', installs: 230, start: 'run_started', highlight: 'run_finished', first: 'First run', events: ['onboarding_completed', 'run_started', 'run_finished', 'route_saved'] },
];

// Remote config: three keys every demo app declares, and one more for
// stillwater. The seed below overrides some of them on the "dashboard", so
// the config pages show overrides, history and an orphan.
const IOS_COPY_TEST = { when: { platform: ['ios'], version: '>=1.4.0' }, rollout: 50, value: 'b', note: 'Copy test from 1.4.0' };
const REVIEW_RULE = { when: { language: ['de', 'nl'] }, rollout: 100, value: 5, note: 'Fewer prompts where reviews ran low' };
const ANDROID_COPY_TEST = { when: { platform: ['android'] }, rollout: 20, value: 'b', note: 'Android joins at 20%' };
const demoConfig = (slug) => ({
  paywall_variant: { type: 'string', default: 'a', description: 'Which paywall copy to show.', rules: [IOS_COPY_TEST] },
  review_prompt_after: { type: 'number', default: 3, description: 'Sessions before the app asks for a review.', rules: [REVIEW_RULE] },
  streak_freeze: {
    type: 'bool', default: false, description: 'Lets a streak survive one missed day.',
    rules: [{ when: { pro: true }, value: true }, { when: { channel: ['testflight'] }, value: true, note: 'Beta testers try it first' }],
  },
  ...(slug === 'stillwater'
    ? { session_lengths: { type: 'json', default: [5, 10, 20], description: 'Session lengths on the start screen, in minutes.' } }
    : {}),
});

/** The catalog a demo runs with when no CATALOG_FILE is given. */
export const DEMO_CATALOG = Object.fromEntries(
  DEMO_APPS.map((a) => [
    a.slug,
    {
      events: a.events,
      highlight: { event: a.highlight, done_prop: 'completed' },
      funnels: [
        { name: a.first, steps: ['app_first_opened', 'onboarding_completed', a.start, a.highlight] },
        {
          name: 'Paywall',
          window_days: 3,
          steps: ['paywall_viewed', 'purchase_started', { event: 'purchase_result', where: { result: 'purchased' }, label: 'Purchased' }],
        },
      ],
      app_store_id: a.appStoreId,
      conversion_values: [
        { value: 1, coarse: 'low', event: 'onboarding_completed', label: 'Onboarded' },
        { value: 4, coarse: 'low', event: a.start, label: 'Started' },
        { value: 12, coarse: 'medium', event: a.highlight, where: { completed: true }, label: a.first },
        { value: 24, coarse: 'medium', event: 'paywall_viewed', label: 'Saw the paywall' },
        { value: 60, coarse: 'high', event: 'purchase_result', where: { result: 'purchased' }, label: 'Purchased', lock: true },
      ],
      breakdowns: [
        { event: 'paywall_viewed', prop: 'source', title: 'Where the paywall opens' },
        { event: 'purchase_started', prop: 'product', title: 'Plans chosen' },
        { event: 'paywall_viewed', prop: 'variant', title: 'Paywall variants seen', count: 'installs' },
      ],
      config: demoConfig(a.slug),
    },
  ]),
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
      // Most installs from the store; a few TestFlight or internal builds on
      // the prod key, which is what the channel filter is for.
      const channel = platform === 'ios' ? weighted(r, [['app_store', 88], ['testflight', 12]]) : weighted(r, [['play', 92], ['internal', 8]]);
      // Paywall copy under test: a global prop the app sets once per launch.
      const variant = r() < 0.5 ? 'a' : 'b';
      let prevFg = 0;
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
        const ev = (name, props = {}, offset = 0) => events.push([uuid(r), app.slug, 'prod', id, session, name, true, at(offset), version, platform, JSON.stringify(props), channel]);
        if (n === 0) ev('app_first_opened');
        if (n === 0 && r() < 0.72) ev('onboarding_completed', {}, 0.5);
        // What SDK 2 sends: the session's number, the previous session's time
        // in the foreground, and where it began (with a campaign for links).
        const entry = weighted(r, [['launch', 74], ['notification', 11], ['widget', 8], ['link', 7]]);
        // Links from ads carry what Meta's URL parameters fill in: the
        // campaign, the ad set (utm_term) and the ad (utm_content).
        const source = entry === 'link' ? weighted(r, [['meta', 45], ['newsletter', 30], ['twitter', 15], ['website', 10]]) : null;
        const campaign = !source
          ? {}
          : source === 'meta'
            ? { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: pick(r, ['autumn_install', 'autumn_retarget']), utm_term: pick(r, ['broad_25_44', 'lookalike_1pct']), utm_content: pick(r, ['video_calm', 'static_streak', 'ugc_review']) }
            : { utm_source: source, utm_campaign: pick(r, ['autumn_update', 'streaks_launch']) };
        ev('session_started', { entry, n: n + 1, ...(prevFg ? { prev_fg_s: prevFg } : {}), ...campaign });
        prevFg = Math.round(20 + Math.pow(r(), 2.2) * 900);
        const screens = 1 + Math.floor(r() * 3);
        for (let s = 0; s < screens; s++) ev('screen_viewed', { screen: pick(r, ['Home', 'Library', 'Stats', 'Settings']) }, s);
        if (!app.startOnce || n === 0) {
          if (r() < 0.8) ev(app.start, {}, 3);
        }
        if (r() < 0.8) ev(app.highlight, { completed: r() < 0.74, minutes: 5 + Math.floor(r() * 20) }, 4);
        if (r() < 0.25) ev(pick(r, app.events.filter((e) => e !== app.highlight)), {}, 6);
        if (n === 0 && r() < 0.32) {
          ev('paywall_viewed', { source: pick(r, ['onboarding', 'settings', 'locked_feature']), variant }, 1);
          if (r() < (variant === 'b' ? 0.42 : 0.3)) {
            ev('purchase_started', { product: pick(r, ['pro_yearly', 'pro_monthly']), variant }, 2);
            ev('purchase_result', { result: pro ? 'purchased' : weighted(r, [['cancelled', 70], ['failed', 30]]), variant }, 3);
          }
        }
        // One name the catalog does not know, so the dashboard's flag shows.
        if (app.slug === 'tally' && r() < 0.05) ev('widget_added', {}, 7);
      }
      installs.push([id, app.slug, 'prod', new Date(first).toISOString(), new Date(last).toISOString(), platform, `${platform} ${platform === 'ios' ? '18.6' : '15'}`, pick(r, DEVICES[platform]), LOCALE[country], country, version, '42', pro, channel, '2.0.0']);
    }
  }

  await tx(async (client) => {
    await client.query('TRUNCATE events, installs, ticket_replies, tickets, write_keys, apps CASCADE');
    await insertRows(client, 'apps', ['slug', 'name'], DEMO_APPS.map((a) => [a.slug, a.name]));
    await insertRows(client, 'installs', ['id', 'app', 'env', 'first_seen', 'last_seen', 'platform', 'os', 'device', 'locale', 'country', 'version', 'build', 'pro', 'channel', 'sdk'], installs);
    // The catalog's known flag is set above from the demo catalog; widget_added is not in it.
    for (const e of events) if (e[5] === 'widget_added') e[6] = false;
    await insertRows(client, 'events', ['id', 'app', 'env', 'install', 'session', 'name', 'known', 'at', 'version', 'platform', 'props', 'channel'], events);
    for (const t of TICKETS) {
      const created = new Date(now - t.daysAgo * DAY - 3 * 3600000);
      // A ticket with an email is not linked to an install, as on a real instance.
      const install = t.email ? null : installs.find((i) => i[1] === t.app)[0];
      const { rows: [row] } = await client.query(
        `INSERT INTO tickets (app, install, email, subject, message, diag, kind, status, created_at, updated_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9, $9) RETURNING id`,
        [t.app, install, t.email ?? null, t.subject, t.message, JSON.stringify({ version: '1.4.0', os: 'ios 18.6', pro: false }), t.kind, t.status, created.toISOString()],
      );
      for (const [k, [author, body]] of t.replies.entries()) {
        await client.query('INSERT INTO ticket_replies (ticket_id, author, body, created_at) VALUES ($1, $2, $3, $4)', [row.id, author, body, new Date(created.getTime() + (k + 1) * 5 * 3600000).toISOString()]);
      }
    }
    // TRUNCATE ... apps CASCADE above emptied both config tables.
    await seedConfig(client, now);
  });
  await seedAttribution(r, now);
  log.info('demo seeded', { apps: DEMO_APPS.length, installs: installs.length, events: events.length, tickets: TICKETS.length });
}

/**
 * A few weeks of dashboard edits to the demo apps' remote config, written as
 * the server would have: each change's stored override and what was served
 * before and after, notes kept. Literals, not remote-config.mjs: that
 * imports catalog.mjs, which imports this file, and the cycle would fail
 * whenever this file loads first. The rows go in time order, so ids ascend
 * with time, and the overrides end as the last change per key left them.
 */
async function seedConfig(client, now) {
  const H = 3600000;
  const D = 24 * H;
  const at = (ms) => new Date(now - ms).toISOString();
  const rollout20 = { ...IOS_COPY_TEST, rollout: 20 };
  const changes = [
    // An override for a key the catalog has since dropped: an orphan.
    ['tally', 'old_onboarding', 20 * D, null, { default: true }, { default: false, rules: [] }, { default: true, rules: [] }, 'Left from the old onboarding test'],
    ['stillwater', 'paywall_variant', 9 * D, null, { rules: [rollout20] }, { default: 'a', rules: [IOS_COPY_TEST] }, { default: 'a', rules: [rollout20] }, 'Start the copy test at 20%'],
    ['stillwater', 'paywall_variant', 5 * D, { rules: [rollout20] }, { rules: [IOS_COPY_TEST] }, { default: 'a', rules: [rollout20] }, { default: 'a', rules: [IOS_COPY_TEST] }, 'Raise to 50%'],
    ['stillwater', 'review_prompt_after', 2 * D, null, { default: 4 }, { default: 3, rules: [REVIEW_RULE] }, { default: 4, rules: [REVIEW_RULE] }, 'Fewer prompts after the 1.4 review dip'],
    ['stillwater', 'paywall_variant', 6 * H, { rules: [IOS_COPY_TEST] }, { rules: [IOS_COPY_TEST, ANDROID_COPY_TEST] }, { default: 'a', rules: [IOS_COPY_TEST] }, { default: 'a', rules: [IOS_COPY_TEST, ANDROID_COPY_TEST] }, 'Android joins the copy test'],
  ];
  const j = (v) => (v === null ? null : JSON.stringify(v));
  for (const [app, key, ago, before, after, effBefore, effAfter, note] of changes) {
    await client.query(
      `INSERT INTO config_changes (app, key, at, action, override_before, override_after, effective_before, effective_after, note)
       VALUES ($1, $2, $3, 'set', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
      [app, key, at(ago), j(before), j(after), j(effBefore), j(effAfter), note],
    );
  }
  // The last change per key; the orphan marked as a boot would have.
  const overrides = [
    ['stillwater', 'paywall_variant', null, [IOS_COPY_TEST, ANDROID_COPY_TEST], 'Android joins the copy test', 6 * H, null],
    ['stillwater', 'review_prompt_after', 4, null, 'Fewer prompts after the 1.4 review dip', 2 * D, null],
    ['tally', 'old_onboarding', true, null, 'Left from the old onboarding test', 20 * D, 10 * D],
  ];
  for (const [app, key, def, rules, note, ago, orphaned] of overrides) {
    await client.query(
      `INSERT INTO config_overrides (app, key, default_value, rules, note, updated_at, orphaned_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
      [app, key, j(def), j(rules), note, at(ago), orphaned === null ? null : at(orphaned)],
    );
  }
}

/**
 * What Apple would report for the demo apps: SKAdNetwork postbacks from Meta
 * campaigns (verified in real life; invented here) and App Store campaign
 * rows, so the Attribution panel shows what it is for.
 */
async function seedAttribution(r, now) {
  const DAY = 86400000;
  const postbacks = [];
  const store = [];
  for (const app of DEMO_APPS) {
    const campaigns = [['1204', 0.5], ['1205', 0.3], ['3310', 0.2]];
    const count = Math.round(app.installs * 0.22);
    for (let i = 0; i < count; i++) {
      const at = new Date(now - Math.floor(Math.pow(r(), 1.3) * 58 * DAY) - 2 * DAY).toISOString();
      const source = weighted(r, campaigns.map(([id, w]) => [id, w]));
      const tier = r();
      // Small campaigns (low crowd-anonymity tiers) get only a coarse value.
      const fine = tier < 0.75 ? weighted(r, [[0, 30], [1, 22], [4, 20], [12, 15], [24, 9], [60, 4]]) : null;
      const coarse = fine === null ? weighted(r, [['low', 70], ['medium', 25], ['high', 5]]) : null;
      const id = uuid(r);
      postbacks.push([`skan:${id}`, 'skan', app.slug, Number(app.appStoreId), at, true, false, '4.0', 'v9wttpbfk9.skadnetwork', source, fine, coarse, 0, true, r() < 0.06, r() < 0.06 ? 'redownload' : 'download', r() < 0.8 ? 'click' : 'view', 1, JSON.stringify({ demo: true })]);
      if (r() < 0.35) {
        postbacks.push([`skan:${id}:1`, 'skan', app.slug, Number(app.appStoreId), at, true, false, '4.0', 'v9wttpbfk9.skadnetwork', source.slice(0, 2), null, weighted(r, [['low', 60], ['medium', 30], ['high', 10]]), 1, true, false, 'download', 'click', 1, JSON.stringify({ demo: true })]);
      }
    }
    for (let d = 3; d < 48; d++) {
      const day = new Date(now - d * DAY).toISOString().slice(0, 10);
      const scale = app.installs / 900;
      for (const [campaign, source, w] of [['meta_autumn', 'Web referrer', 1], ['meta_retarget', 'Web referrer', 0.4], ['newsletter', 'Web referrer', 0.25], ['', 'App Store search', 2.2], ['', 'App Store browse', 0.9]]) {
        const views = Math.round((20 + r() * 25) * w * scale * 3);
        const downloads = Math.round(views * (0.18 + r() * 0.12));
        if (downloads < 1) continue;
        const purchases = Math.round(downloads * (0.03 + r() * 0.04));
        for (const [kind, metric, value] of [
          ['engagement', 'impressions', views * 6],
          ['engagement', 'page_views', views],
          ['downloads', 'first_downloads', downloads],
          ['downloads', 'redownloads', Math.round(downloads * 0.08)],
          ['sessions', 'sessions', Math.round(downloads * 3.4)],
          ['purchases', 'purchases', purchases],
          ['purchases', 'proceeds_usd', Math.round(purchases * 24.99 * 0.85 * 100) / 100],
        ]) {
          store.push([app.slug, kind, day, campaign, source, metric, value, day]);
        }
      }
    }
  }
  await tx(async (client) => {
    await insertRows(client, 'postbacks', ['dedupe', 'kind', 'app', 'apple_app_id', 'received_at', 'verified', 'development', 'version', 'ad_network', 'source_identifier', 'conversion_value', 'coarse_value', 'sequence', 'did_win', 'redownload', 'conversion_type', 'interaction', 'fidelity', 'raw'], postbacks);
    await insertRows(client, 'asc_campaigns', ['app', 'kind', 'day', 'campaign', 'source_type', 'metric', 'value', 'processing_date'], store);
    await insertRows(client, 'asc_requests', ['app', 'request_id', 'last_sync'], DEMO_APPS.map((a) => [a.slug, 'demo', new Date(now - 3 * 3600000).toISOString()]));
  });
}
