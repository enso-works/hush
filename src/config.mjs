// Everything comes from the environment. See .env.example for the full list
// with notes; nothing here assumes a particular host, proxy or mail sender.
const env = (k, d = '') => process.env[k] ?? d;

export const cfg = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL'),
  // Guards /admin/* and the dashboard's data. TELEMETRY_ADMIN_TOKEN is the
  // name early deployments used; it still works.
  adminToken: env('ADMIN_TOKEN') || env('TELEMETRY_ADMIN_TOKEN'),
  // A proxy on a private network may sign the dashboard in for its users by
  // sending this header with this secret on /admin/*, instead of the token.
  // Both or neither; the secret at least 16 characters. Only set it when the
  // proxy overwrites the header, or anyone who learns the secret is admin.
  adminProxyHeader: env('ADMIN_PROXY_HEADER').toLowerCase(),
  adminProxySecret: env('ADMIN_PROXY_SECRET'),
  // Apps to register at boot, "slug=Display Name,other=Other". Idempotent:
  // an existing app keeps its row. Apps can also be added with the CLI.
  apps: env('APPS'),
  // Path to the per-app event catalog (src/catalog.mjs). Optional.
  catalogFile: env('CATALOG_FILE'),
  // The request header a trusted proxy puts the caller's two-letter country
  // in, e.g. "cf-ipcountry" behind Cloudflare. Unset: no country is stored
  // at all. Only set it when the proxy overwrites the header, or any client
  // can claim any country.
  countryHeader: env('COUNTRY_HEADER').toLowerCase(),
  // The header a trusted proxy puts the caller's address in, for the rate
  // limits: "cf-connecting-ip" behind Cloudflare, "x-forwarded-for" behind
  // most others. Unset: the socket address, right when nothing sits in front.
  clientIpHeader: env('CLIENT_IP_HEADER').toLowerCase(),
  resendKey: env('RESEND_API_KEY'),
  // The sender for ticket mail, on a domain verified in Resend.
  mailFrom: env('MAIL_FROM'),
  // Where a new ticket or a user's reply is announced. Unset: nothing is
  // mailed; tickets are still stored and shown on the dashboard.
  alertEmail: env('ALERT_EMAIL'),
  // A line at the end of every alert saying where to answer, e.g. the
  // dashboard's URL. Optional.
  replyHint: env('REPLY_HINT'),
  mailDryRun: env('MAIL_DRY_RUN') === '1',
  // A public, read-only showcase with invented data (src/demo.mjs). Opens
  // /admin reads without a token and wipes its database daily, so it must
  // have a database of its own; it refuses to start on one with write keys.
  demo: env('DEMO') === '1',
  retentionDays: Number(env('RETENTION_DAYS', '180')),
  // Installs that have sent nothing for this many days are deleted, in the
  // same sweep (src/sweep.mjs). Unset: RETENTION_DAYS, when the install's
  // events are gone and its row is all that is left. 0 keeps every install.
  installRetentionDays: Number(env('INSTALL_RETENTION_DAYS') || env('RETENTION_DAYS', '180')),
  // RevenueCat, read-only. A v2 *secret* key: it never reaches a browser or a
  // phone, only the poller in this process. Empty = the revenue section says
  // the key is missing instead of the pages breaking.
  rcApiKey: env('RC_API_KEY'),
  // "myapp=projabc,other=projdef" — only needed when a project's name is not
  // the app's slug or display name.
  rcProjects: env('RC_PROJECTS'),
  rcCurrency: env('RC_CURRENCY', 'USD'),
  // How old the cache may be before opening the page refreshes it, and how
  // soon the refresh button is allowed to ask again.
  rcStaleMinutes: Math.max(Number(env('RC_STALE_MINUTES', '10')) || 10, 1),
  // A full pull is a dozen-odd requests, so the floor is a minute: two pulls
  // inside one rate window would queue behind the limiter below.
  rcFloorSeconds: Math.max(Number(env('RC_FLOOR_SECONDS', '60')) || 60, 5),
  // RevenueCat allows 25 Charts & Metrics requests a minute per key.
  rcRatePerMinute: Math.max(Number(env('RC_RATE_PER_MINUTE', '20')) || 20, 1),
  // App Store Connect API key for campaign reports (src/appstore.mjs): its key
  // id, issuer id and the .p8 (inline, \n allowed, or a file). The Admin role
  // once, to create each app's report request; Sales and Reports after that.
  // Unset: no App Store campaigns, and nothing else changes.
  ascKeyId: env('ASC_KEY_ID'),
  ascIssuerId: env('ASC_ISSUER_ID'),
  ascPrivateKey: env('ASC_PRIVATE_KEY'),
  ascPrivateKeyFile: env('ASC_PRIVATE_KEY_FILE'),
  ascApiBase: env('ASC_API_BASE', 'https://api.appstoreconnect.apple.com'),
  // Push to the hush iOS app (src/push.mjs) for new feedback and replies:
  // an APNs auth key (Apple Developer, Keys, APNs) of the team that signs the
  // app. One key serves every app of a team. The .p8 inline (\n allowed) or
  // base64. Unset: phones can still sign up, and nothing is sent.
  apnsKeyId: env('APNS_KEY_ID'),
  apnsTeamId: env('APNS_TEAM_ID'),
  apnsKey: env('APNS_KEY_P8').replace(/\\n/g, '\n') || (env('APNS_KEY_P8_BASE64') && Buffer.from(env('APNS_KEY_P8_BASE64'), 'base64').toString('utf8')),
  // The app's bundle id; a build of the iOS app under another one sets it.
  apnsTopic: env('APNS_TOPIC', 'com.bavrk.hush'),
  // Without an APNs key of its own, a server pushes to the App Store hush app
  // through bavrk's relay (src/relay.mjs): sealed, so the relay sees a token
  // and an opaque blob, never what was written. Only used for phones that
  // turned notifications on. "off" turns it off.
  pushRelay: ['off', 'false', '0'].includes(env('PUSH_RELAY').toLowerCase()) ? '' : env('PUSH_RELAY', 'https://hush.bavrk.com/push').replace(/\/+$/, ''),
  // Runs this server as that relay (with its APNs key): /push/register and
  // /push/send. The secret signs the passes; 32 characters at least.
  relaySecret: env('PUSH_RELAY_SECRET'),
  // Apple's hosts; the tests point these at a local HTTP/2 server.
  apnsHost: env('APNS_HOST', 'https://api.push.apple.com'),
  apnsSandboxHost: env('APNS_SANDBOX_HOST', 'https://api.sandbox.push.apple.com'),
};

// How long an install row outlives its last batch, in whole days; null when
// every install is kept (0, or a value that is not a whole number of days).
export const installRetention = Number.isInteger(cfg.installRetentionDays) && cfg.installRetentionDays > 0 ? cfg.installRetentionDays : null;

export const log = {
  info: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg, ...extra })),
  warn: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg, ...extra })),
};

/** "slug=Name,other=Other Name" -> [{ slug, name }]; throws on a malformed entry so a typo stops the boot. */
export function parseApps(value) {
  if (!value.trim()) return [];
  return value.split(',').map((part) => {
    const [slug, ...rest] = part.split('=');
    const s = slug.trim();
    const name = rest.join('=').trim() || s;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(s)) throw new Error(`APPS: "${part.trim()}" is not slug=Name (slug: lowercase letters, digits, dashes)`);
    return { slug: s, name };
  });
}
