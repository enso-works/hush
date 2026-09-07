# Extracting this into `hush`, a self-hosted open-source project

Status: decided 2026-09-07, **not started on purpose**. The trigger is below.

Anonymous analytics and in-app support for small mobile apps: one small
container, Postgres, a one-file SDK, and a dashboard. No consent banner needed,
because nothing personal is collected. That is a real niche and it is the same
code the fleet runs anyway, so it goes out under its own name.

- Repo: `enso-works/hush` (free as of 2026-09-07), MIT.
- npm: **`@bavrk/hush`** — the bare `hush` is taken (an unrelated v0.2.3). The
  `@bavrk` scope does not exist yet; create it at first publish.

## When: after Braele 1.4.0 has run for about two weeks

Not before. The service has never served a production request. Extracting now
would publish and version an API that has not met real data, and the first week
of live events is exactly what will change it. Shipping 1.4.0 also matters more.

The trigger to start: 1.4.0 live, events and tickets arriving, and nothing in
the schema or the endpoints changed for a week.

## What moves, and what does not

| Piece | Today | In `hush` |
|---|---|---|
| Service | `telemetry/` — Node 22, `pg` only, migrations, `/v1/*` and `/admin/*` | `server/`, wholesale |
| SDK | `braele/src/lib/telemetry.ts`, copied per app | `sdk/`, published as `@bavrk/hush` |
| Dashboard | Cockpit's Apps and Tickets pages | **New code.** The Cockpit pages stay where they are — they are bound to Cloudflare Access, the tailnet header, the audit log and Cockpit's own CSS. `hush` needs its own small UI, served by the same container, guarded by a token. |
| `deploy-telemetry.yml`, the Caddy block, the `healthcheck.sh` entry | bavrk | Stay in bavrk. An example `docker-compose.yml` ships instead. |

## How bavrk consumes it: `git subtree`, never a submodule

`telemetry/` stays a real directory in this repo, synced with
`git subtree pull --prefix telemetry <hush remote> main --squash`. The deploy
workflow rsyncs that directory and does not change at all.

Submodules are ruled out by scar tissue: a stale `SUBMODULES_PAT` blocked every
app's deploy in this repo for five months (last good run 2026-03-07, 29 commits
undeployed by the time it was found). Nothing that gates a deploy on another
repo's credentials gets added back.

Braele keeps its copied `src/lib/telemetry.ts` until the SDK's API settles, then
switches to the npm package like any other dependency. `app-template` follows.

## What has to be built before it is publishable

Moving the files is the easy half.

1. **App registration as config, not a migration.** `001_init.sql` seeds the
   fleet's own slugs; that becomes `hush apps:add <slug> <name>` (the CLI
   already exists) and an optional `HUSH_APPS` env for first boot.
2. **Event catalog per app as data.** `src/catalog.mjs` hardcodes Braele's
   thirteen events; unknown names are already accepted and flagged, so this
   becomes a per-app JSON the operator supplies, or nothing at all.
3. **Its own dashboard**, token-guarded, served by the container: portfolio
   table, one app view, the ticket inbox with replies. The Cockpit pages are
   the design reference, not the source.
4. **Tests.** Everything here is currently verified by hand, which is fine for
   us and not fine for a repo that asks strangers to point it at their users'
   data. At minimum: ingest (validation, dedupe, the `pro` tri-state), tickets
   (quota race, app scoping, unread cutoff), and a migration run from empty.
5. **Docs**: a five-minute quickstart, an example `docker-compose.yml`, an
   example `.env`, the privacy model stated plainly, and an example Expo app.
6. **A scrub pass**: no bavrk hostnames, IPs, container names or Cloudflare
   assumptions in anything that ships (`CF-IPCountry` becomes optional, with a
   documented fallback of storing no country at all).

## What it costs after that

About an hour per meaningful change to sync both ways, plus whatever issue
triage arrives. Worth knowing before flipping it public: a self-hosted service
with a public ingest endpoint invites probing, and the rate limits here are
in-memory and single-instance. That is honest for what it is, and the README
should say so.
