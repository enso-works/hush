# Accounts: design

A proposal, 2026-10-06. Nothing here is built yet. It is written down first so
the access model is agreed before code depends on it.

## What it is for

- Several people on one hush server, each signing in as themselves, with a
  role and, when needed, only some of the apps.
- A record of who did what: replies, status changes, deletes, config
  overrides, forgotten installs, keys.
- Alerts per person instead of one `ALERT_EMAIL`.
- Ready for hosting hush for other people later: everything belongs to a
  team from the first migration. Signup, billing and quotas are not part of
  this.

What does not change:

- `/v1` and the write keys. A key belongs to an app, an app to a team; the
  SDKs and `test/__snapshots__/v1-compat.json` stay as they are.
- A server nobody configures accounts on works exactly as today: the
  `ADMIN_TOKEN`, the proxy header and paired phones keep full access.

## The model

One migration (`011_accounts.sql`):

| Table | Columns | Notes |
|---|---|---|
| `teams` | `id`, `name`, `created_at` | The migration creates team 1, "Default". |
| `apps` | adds `team_id NOT NULL DEFAULT 1 REFERENCES teams` | Every existing app is in team 1. |
| `users` | `id`, `email` (unique, lowercased), `name`, `created_at`, `last_seen_at`, `disabled_at` | |
| `memberships` | `team_id`, `user_id`, `role`, `apps text[]`, `created_at`; key `(team_id, user_id)` | `role`: owner, admin, member, viewer. `apps` NULL is every app of the team. |
| `sessions` | `id`, `user_id`, `token_hash` (unique), `created_at`, `last_seen_at`, `expires_at`, `user_agent` | The dashboard's sign-in. Only the hash is stored, as for keys and phones. |
| `login_links` | `token_hash`, `user_id`, `expires_at`, `used_at` | Single use, 15 minutes. |
| `invitations` | `token_hash`, `team_id`, `email`, `role`, `apps`, `invited_by`, `expires_at` | Seven days. |
| `admin_devices` | adds `user_id` (nullable) | A phone paired by a person acts as that person. NULL is a phone paired before accounts, which keeps owner access. |
| `audit_log` | `id`, `at`, `team_id`, `actor_user_id`, `actor` (user, token, proxy, device), `action`, `app`, `target`, `detail jsonb` | Append-only. |
| `ticket_replies`, `config_changes` | add `user_id` (nullable) | "Answered by Ana" on the thread, "changed by" in the config history. |
| `alert_subscriptions` | `user_id`, `app`, `events` (ticket, reply) | Replaces `ALERT_EMAIL`, which stays as a server-wide address. Push uses the same rows per phone. |
| `passkeys` | `credential_id`, `user_id`, `public_key`, `sign_count`, `name`, `created_at` | Second step, after sign-in links. |

## Who is calling

The admin gate (`src/server.mjs`) resolves one principal per request and
hands it to every handler, instead of a yes or no:

1. A session cookie, `hush_session` (HttpOnly, Secure, SameSite=Strict):
   that user, with their membership.
2. `Bearer hush_device_…`: the phone's user. A phone without one (paired
   before accounts) is the owner.
3. `Bearer <ADMIN_TOKEN>`: the owner of every team. The emergency key, and
   what the CLI and scripts use.
4. The proxy header: the owner, as today. Later, `ADMIN_PROXY_USER_HEADER`
   may name the person instead (Tailscale's `Tailscale-User-Login`), so
   bavrk's ops dashboard signs each of us in as ourselves.

A principal is `{ actor, user, team, role, apps }`. Every route asks
`can(principal, action, app)`. A ticket, install or app outside what the
principal may see answers 404, never 403: nothing confirms it exists.

## Roles

| | viewer | member | admin | owner |
|---|---|---|---|---|
| Numbers, events, funnels, revenue | yes | yes | yes | yes |
| Read feedback | yes | yes | yes | yes |
| Reply, close, reopen | | yes | yes | yes |
| Delete a ticket, forget an install | | | yes | yes |
| Remote config overrides | | | yes | yes |
| Write keys, apps | | | yes | yes |
| Invite and remove members and viewers | | | yes | yes |
| Manage admins and owners, the team | | | | yes |
| Audit log | | | yes | yes |

`apps` limits a member or a viewer to some of the team's apps. Admins and
owners always see every app of the team.

## Every query scoped

Today the routes that are not per app read every app: `/admin/apps`,
`/admin/tickets` and `/admin/tickets/:id`, `/admin/installs/:id` and its
forget, `/admin/revenue`, `/admin/devices`. Each gets the principal's team
and apps: `WHERE a.team_id = $1 AND ($2::text[] IS NULL OR a.slug = ANY($2))`.
`forgetInstall` deletes only in the apps the principal may change.

One test reads the router's table of routes and calls every `/admin` route
as each role, with and without an app limit, checking each against the
table above. A new route without a rule fails it.

## Signing in

- **The dashboard:** an email, then a sign-in link by mail (Resend, as
  replies are sent; `MAIL_DRY_RUN` logs the link). The link sets the session
  cookie: 30 days, extended while used. The token sign-in stays, under "Use
  the admin token".
- **Without mail:** `node src/cli.mjs users:add <email> --role owner` prints
  a one-time sign-in link.
- **The first account:** signed in with the admin token, the dashboard offers
  to create the owner account. Until one exists, nothing changes.
- **Passkeys** come after, so a phone or a laptop signs in without mail.
  Verified with `node:crypto` (ES256 and RS256), keeping the server at one
  runtime dependency.
- **The phone:** the dashboard's QR code is made by a signed-in person, and
  the phone it pairs acts as that person. Disabling a person revokes their
  phones and sessions.
- **Writes** keep today's rule (JSON, not cross-site), which with a
  SameSite=Strict cookie is the CSRF protection.

## Hosting for others, later

The schema above already keeps teams apart, and ingestion needs no change
(key, app, team). What hosting would add, when decided:

- Signup that creates a team, and leaving or deleting one.
- Per-team limits: apps, events a day, a rate limit per write key.
- Per-team settings in the database: the RevenueCat key, the App Store
  Connect key, the catalog (today one file and one environment for the
  server).
- Postgres row-level security on `team_id`, under the scoping above.
- Billing.

## Order of work

Each a pull request, with the README, the site's docs page and the plugin's
server reference updated in the same change.

1. The migration, the principal, `can()`, scoped queries and the route test.
   No sign-in yet: the admin token, the proxy and phones are owners, as now.
2. Users, sign-in links, the session cookie, the dashboard's sign-in and a
   Team page (invite, roles, app access); `users:*` in the CLI.
3. Who did what: `user_id` on replies and config changes, the audit log,
   "Answered by" in the web and iOS threads.
4. Phones belong to people: the Phones page shows whose; the iOS app shows
   who it is signed in as.
5. Alerts per person, by mail and by push.
6. Passkeys.
7. The proxy naming the person, for ops.

## Open questions

- "Team" or "workspace": this proposal says team.
- Should a member delete a ticket? This proposal says no: it is for a user's
  "please delete my message", which an admin handles.
- Session length: 30 days, extended while used. Phones: until revoked.
