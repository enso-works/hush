// Everything comes from the environment. See .env.example for the full list
// with notes; nothing here assumes a particular host, proxy or mail sender.
const env = (k, d = '') => process.env[k] ?? d;

export const cfg = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL'),
  // Guards /admin/* and the dashboard's data. TELEMETRY_ADMIN_TOKEN is the
  // name early deployments used; it still works.
  adminToken: env('ADMIN_TOKEN') || env('TELEMETRY_ADMIN_TOKEN'),
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
  retentionDays: Number(env('RETENTION_DAYS', '180')),
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
};

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
