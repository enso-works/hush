// The hush dashboard: one file, no build, no dependencies. It reads the same
// /admin API anyone can script against, with the admin token kept in
// sessionStorage (gone when the tab closes, never a cookie, so there is
// nothing for another site to ride on). Every piece of text that came from a
// user goes into the page as a text node, never as HTML.

const TOKEN_KEY = 'hush.token';
const view = document.getElementById('view');
const nav = document.getElementById('nav');
// Where the API lives: wherever the dashboard is served from, minus
// /dashboard/. Usually the root; `/demo` when a proxy mounts a demo there.
const BASE = location.pathname.replace(/\/dashboard(\/.*)?$/, '');
// A demo server answers /admin reads without a token; found out once, at start.
let demo = false;

// --- tiny DOM helper: h('div', { class: 'x' }, 'text', child)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const render = (...nodes) => view.replaceChildren(...nodes);

// --- API
class AuthError extends Error {}
async function api(path, { method = 'GET', body } = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token && !demo) throw new AuthError();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new AuthError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// --- formatting
const num = (n) => (n == null ? '–' : Number(n).toLocaleString());
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const when = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
function delta(now, before) {
  if (!before) return h('span', { class: 'delta flat' }, now ? 'new' : '–');
  const change = Math.round(((now - before) / before) * 100);
  const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  return h('span', { class: `delta ${dir}` }, `${change > 0 ? '+' : ''}${change}%`);
}
const kpi = (label, value, extra) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), extra ?? '');

// --- state kept across views
const prefs = { days: Number(sessionStorage.getItem('hush.days')) || 30, env: sessionStorage.getItem('hush.env') || 'prod' };
function controls(onChange) {
  const days = h('select', { 'aria-label': 'Period', onchange: (e) => { prefs.days = Number(e.target.value); sessionStorage.setItem('hush.days', prefs.days); onChange(); } },
    ...[7, 30, 90, 365].map((d) => h('option', { value: d, selected: d === prefs.days }, `Last ${d} days`)));
  const env = h('select', { 'aria-label': 'Environment', onchange: (e) => { prefs.env = e.target.value; sessionStorage.setItem('hush.env', prefs.env); onChange(); } },
    ...['prod', 'dev'].map((v) => h('option', { value: v, selected: v === prefs.env }, v)));
  return h('div', { class: 'controls' }, days, env);
}

// --- views
function login(message) {
  nav.hidden = true;
  const input = h('input', { type: 'password', name: 'token', autocomplete: 'current-password', placeholder: 'Admin token', required: true });
  render(h('div', { class: 'login card' },
    h('h1', {}, 'hush'),
    h('p', { class: 'sub' }, 'Enter the ADMIN_TOKEN this server was started with.'),
    message ? h('p', { class: 'error' }, message) : '',
    h('form', { onsubmit: (e) => { e.preventDefault(); sessionStorage.setItem(TOKEN_KEY, input.value.trim()); route(); } },
      input, h('button', { type: 'submit' }, 'Open dashboard'))));
  input.focus();
}

async function appsView() {
  const { apps } = await api(`/admin/apps?days=${prefs.days}&env=${prefs.env}`);
  const rows = apps.map((a) => h('tr', {},
    h('td', {}, h('a', { href: `#/app/${encodeURIComponent(a.app)}` }, a.name), ' ', h('span', { class: 'tag' }, a.app)),
    h('td', { class: 'num' }, num(a.total_installs)),
    h('td', { class: 'num' }, num(a.new_installs)),
    h('td', { class: 'num' }, num(a.dau)),
    h('td', { class: 'num' }, num(a.wau)),
    h('td', { class: 'num' }, num(a.mau)),
    h('td', { class: 'num' }, num(a.sessions)),
    h('td', { class: 'num' }, a.open_tickets ? h('a', { href: '#/tickets' }, h('span', { class: 'tag open' }, a.open_tickets)) : '0'),
    h('td', {}, when(a.last_event))));
  render(
    h('h1', {}, 'Apps'),
    h('p', { class: 'sub' }, `${apps.length} app${apps.length === 1 ? '' : 's'}, ${prefs.env}`),
    controls(route),
    h('div', { class: 'card' }, apps.length
      ? h('table', {},
          h('thead', {}, h('tr', {}, ...['App', 'Installs', 'New', 'DAU', 'WAU', 'MAU', 'Sessions', 'Open tickets', 'Last event'].map((t, i) => h('th', { class: i && i < 8 ? 'num' : '' }, t)))),
          h('tbody', {}, rows))
      : h('p', { class: 'empty' }, 'No apps yet. Register one with APPS or `node src/cli.mjs apps:add <slug> <name>`, then mint a key with keys:create.')),
  );
}

function barChart(daily) {
  const max = Math.max(1, ...daily.map((d) => d.active));
  return h('div', {},
    h('div', { class: 'bars', role: 'img', 'aria-label': 'Active installs per day' },
      ...daily.map((d) => h('div', { class: 'bar', title: `${d.day}: ${d.active} active, ${d.sessions} sessions, ${d.new_installs} new`, style: { height: `${(d.active / max) * 100}%` } }))),
    h('div', { class: 'axis' }, h('span', {}, daily[0]?.day ?? ''), h('span', {}, daily.at(-1)?.day ?? '')));
}

const smallTable = (heads, rows, empty = 'Nothing yet.') =>
  rows.length
    ? h('table', {}, h('thead', {}, h('tr', {}, ...heads.map((t, i) => h('th', { class: i ? 'num' : '' }, t)))), h('tbody', {}, ...rows))
    : h('p', { class: 'empty' }, empty);

async function appView(slug) {
  const [d, money] = await Promise.all([
    api(`/admin/apps/${encodeURIComponent(slug)}?days=${prefs.days}&env=${prefs.env}`),
    api(`/admin/revenue?app=${encodeURIComponent(slug)}&days=${prefs.days}`).catch(() => null),
  ]);
  const c = d.current;
  const p = d.prior;
  const kpis = [
    kpi('Active installs', num(c.active), delta(c.active, p.active)),
    kpi('New installs', num(c.new_installs), delta(c.new_installs, p.new_installs)),
    kpi('Sessions', num(c.sessions), delta(c.sessions, p.sessions)),
    kpi('Active today', num(d.todayActive)),
  ];
  if (d.highlight) {
    kpis.push(kpi(d.highlight.event.replace(/_/g, ' '), num(c.highlight), delta(c.highlight, p.highlight)));
    if (d.highlight.done_prop) kpis.push(kpi(`Completed (${d.highlight.done_prop})`, pct(c.highlight_done, c.highlight)));
  }
  const ret = (label, r) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, num(r.cohort)), h('td', { class: 'num' }, num(r.retained)), h('td', { class: 'num' }, pct(r.retained, r.cohort)));

  const moneyCard = (() => {
    if (!money?.configured) return '';
    const project = money.apps.find((a) => a.app === slug);
    if (!project) return h('div', { class: 'card' }, h('h2', {}, 'Revenue'), h('p', { class: 'empty' }, 'No RevenueCat project is linked to this app (see rc:projects and rc:link).'));
    const metrics = Object.entries(project.metrics ?? {});
    return h('div', { class: 'card' },
      h('h2', {}, 'Revenue'),
      project.last_error ? h('p', { class: 'error' }, `Last refresh failed: ${project.last_error}`) : '',
      h('p', { class: 'sub' }, `RevenueCat, ${project.currency ?? ''}, as of ${when(project.fetched_at)}`),
      smallTable(['Metric', 'Value'], metrics.map(([k, v]) => h('tr', {}, h('td', {}, k.replace(/_/g, ' ')), h('td', { class: 'num' }, typeof v === 'object' && v !== null ? num(v.value) : num(v))))));
  })();

  render(
    h('p', { class: 'sub' }, h('a', { href: '#/' }, '← Apps')),
    h('h1', {}, d.name ?? slug),
    h('p', { class: 'sub' }, `Last event ${when(d.lastEvent)} · ${d.tickets} open ticket${d.tickets === 1 ? '' : 's'}`),
    controls(route),
    h('div', { class: 'kpis' }, ...kpis),
    h('div', { class: 'card' }, h('h2', {}, 'Active installs per day'), barChart(d.daily)),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h2', {}, 'Paywall funnel'), smallTable(['Step', 'Installs'], d.funnel.map((f) => h('tr', {}, h('td', {}, f.name.replace(/_/g, ' ')), h('td', { class: 'num' }, num(f.installs)))))),
      h('div', { class: 'card' }, h('h2', {}, 'Retention'), smallTable(['', 'Cohort', 'Came back', ''], [ret('Day 1', d.retention.d1), ret('Day 7', d.retention.d7), ret('Day 30', d.retention.d30)])),
      h('div', { class: 'card' }, h('h2', {}, 'Versions'), smallTable(['Version', 'Installs'], d.versions.map((v) => h('tr', {}, h('td', {}, v.version), h('td', { class: 'num' }, num(v.installs)))))),
      h('div', { class: 'card' }, h('h2', {}, 'Countries'), smallTable(['Country', 'Installs'], d.countries.map((x) => h('tr', {}, h('td', {}, x.country), h('td', { class: 'num' }, num(x.installs)))), 'No countries (COUNTRY_HEADER is not set, or nothing arrived yet).'))),
    h('div', { class: 'card' },
      h('h2', {}, 'Events'),
      smallTable(['Event', 'Count', 'Installs'], d.events.map((e) => h('tr', {},
        h('td', {}, e.name, ' ', e.known ? '' : h('span', { class: 'tag warn', title: 'Not in this app\'s catalog: a typo, or a name to add to CATALOG_FILE' }, 'unknown')),
        h('td', { class: 'num' }, num(e.n)), h('td', { class: 'num' }, num(e.installs)))))),
    moneyCard,
  );
}

async function ticketsView(params) {
  const status = params.get('status') ?? 'open';
  const { tickets } = await api(`/admin/tickets${status === 'all' ? '' : `?status=${status}`}`);
  const filter = h('select', { 'aria-label': 'Status', onchange: (e) => { location.hash = `#/tickets?status=${e.target.value}`; } },
    ...['open', 'answered', 'closed', 'all'].map((s) => h('option', { value: s, selected: s === status }, s)));
  render(
    h('h1', {}, 'Tickets'),
    h('p', { class: 'sub' }, `${tickets.length} ${status === 'all' ? '' : status} ticket${tickets.length === 1 ? '' : 's'}`),
    h('div', { class: 'controls' }, filter),
    h('div', { class: 'card' }, tickets.length
      ? h('table', {},
          h('thead', {}, h('tr', {}, ...['Ticket', 'App', 'Kind', 'Status', 'Replies', 'Opened'].map((t, i) => h('th', { class: i === 4 ? 'num' : '' }, t)))),
          h('tbody', {}, ...tickets.map((t) => h('tr', {},
            h('td', {}, h('a', { href: `#/tickets/${t.id}` }, t.subject || t.preview || `#${t.id}`)),
            h('td', {}, t.app),
            h('td', {}, h('span', { class: 'tag' }, t.kind)),
            h('td', {}, h('span', { class: `tag ${t.status === 'open' ? 'open' : ''}` }, t.status)),
            h('td', { class: 'num' }, num(t.replies)),
            h('td', {}, when(t.created_at))))))
      : h('p', { class: 'empty' }, 'Nothing here.')));
}

async function ticketView(id) {
  const t = await api(`/admin/tickets/${encodeURIComponent(id)}`);
  const reply = h('textarea', { name: 'body', placeholder: t.email ? `Reply (also emailed to ${t.email})` : 'Reply (shown in the app; no email was given)', required: true });
  const close = h('input', { type: 'checkbox', id: 'close' });
  const status = h('p', { class: 'sub', role: 'status' });
  const setStatus = async (s) => {
    await api(`/admin/tickets/${t.id}/status`, { method: 'POST', body: { status: s } });
    route();
  };
  const diag = Object.entries(t.diag ?? {});
  render(
    h('p', { class: 'sub' }, h('a', { href: '#/tickets' }, '← Tickets')),
    h('h1', {}, t.subject || `Ticket #${t.id}`),
    h('p', { class: 'sub' }, `${t.app} · ${t.kind} · ${t.status} · opened ${when(t.created_at)}`),
    h('div', { class: 'grid' },
      h('div', { class: 'card', style: { gridColumn: 'span 2' } },
        h('div', { class: 'thread' },
          h('div', { class: 'msg' }, h('div', { class: 'meta' }, `User · ${new Date(t.created_at).toLocaleString()}`), t.message),
          ...(t.replies ?? []).map((r) => h('div', { class: `msg ${r.author}` }, h('div', { class: 'meta' }, `${r.author === 'support' ? 'Support' : 'User'} · ${new Date(r.at).toLocaleString()}`), r.body))),
        demo
          ? h('p', { class: 'sub', style: { marginTop: '14px' } }, 'Replying is switched off in the demo. On your own instance you answer here, and the user reads it in the app (and by email, if they left one).')
          : t.status === 'closed'
          ? h('p', { class: 'sub', style: { marginTop: '14px' } }, 'Closed: the app offers a new message instead of a reply. ', h('button', { class: 'link', onclick: () => setStatus('open') }, 'Reopen'))
          : h('form', { style: { marginTop: '14px', display: 'grid', gap: '10px' }, onsubmit: async (e) => {
              e.preventDefault();
              const button = e.target.querySelector('button[type=submit]');
              button.disabled = true;
              try {
                await api(`/admin/tickets/${t.id}/reply`, { method: 'POST', body: { body: reply.value, close: close.checked } });
                route();
              } catch (err) {
                status.textContent = `Not sent: ${err.message}`;
                button.disabled = false;
              }
            } },
            reply,
            h('label', {}, close, ' Close after replying'),
            h('div', { class: 'controls' }, h('button', { type: 'submit' }, 'Send reply'), h('button', { type: 'button', class: 'secondary', onclick: () => setStatus('closed') }, 'Close without replying')),
            status)),
      h('div', { class: 'card' },
        h('h2', {}, 'About'),
        h('dl', { class: 'facts' },
          h('dt', {}, 'Install'), h('dd', {}, t.install),
          h('dt', {}, 'Email'), h('dd', {}, t.email ?? 'none given'),
          h('dt', {}, 'Customer'), h('dd', {}, t.rc_id ?? '–'),
          ...diag.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])))));
}

// --- router
async function route() {
  if (!sessionStorage.getItem(TOKEN_KEY) && !demo) return login();
  nav.hidden = false;
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query ?? '');
  const parts = path.split('/').filter(Boolean);
  render(h('p', { class: 'empty' }, 'Loading…'));
  try {
    if (parts[0] === 'app' && parts[1]) await appView(decodeURIComponent(parts[1]));
    else if (parts[0] === 'tickets' && parts[1]) await ticketView(parts[1]);
    else if (parts[0] === 'tickets') await ticketsView(params);
    else await appsView();
  } catch (err) {
    if (err instanceof AuthError) return login('That token was not accepted.');
    render(h('div', { class: 'card' }, h('p', { class: 'error' }, `Could not load this page: ${err.message}`)));
  }
}

document.getElementById('signout').addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  login();
});
window.addEventListener('hashchange', route);

// Is this a demo? It answers /admin without a token; a real server says 401.
fetch(`${BASE}/admin/apps?days=1`)
  .then((r) => {
    if (!r.ok) return;
    demo = true;
    document.getElementById('signout').hidden = true;
    document.body.prepend(h('div', { class: 'demo-banner', role: 'note' },
      'Demo: invented apps and data, read-only. ',
      h('a', { href: 'https://github.com/enso-works/hush' }, 'Run your own'), '.'));
  })
  .catch(() => {})
  .finally(route);
