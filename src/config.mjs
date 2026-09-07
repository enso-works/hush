// Everything comes from the environment; docker-compose.yml passes the
// relevant /opt/bavrk/.env values through.
const env = (k, d = '') => process.env[k] ?? d;

export const cfg = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL'),
  // Guards /admin/*. Those routes are only reachable from the docker network
  // (Caddy never proxies them), the token is the second lock.
  adminToken: env('TELEMETRY_ADMIN_TOKEN'),
  resendKey: env('RESEND_API_KEY'),
  mailFrom: env('MAIL_FROM', 'Bavrk Support <support@bavrk.com>'),
  // Where a new ticket is announced.
  alertEmail: env('ALERT_EMAIL', 'ensar.bavrk@gmail.com'),
  mailDryRun: env('MAIL_DRY_RUN') === '1',
  retentionDays: Number(env('RETENTION_DAYS', '180')),
};

export const log = {
  info: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg, ...extra })),
  warn: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg, ...extra })),
};
