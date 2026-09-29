# Contributing

## Running the tests

The suite runs the real server (`node src/server.mjs`) against a real
Postgres, one fresh database per test file, so migrations from empty run
every time.

```bash
docker run -d --rm --name hush-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
npm ci
npm test
```

Any Postgres you can create databases on works: point `TEST_DATABASE_URL` at
it (default `postgresql://test:test@127.0.0.1:55432/postgres`).

The SDK is type-checked on its own: `cd sdk && npx tsc --noEmit -p tsconfig.json`.

## The /v1 contract is frozen

`test/compat.test.mjs` replays a fixed script against `/v1` and compares every
status code and body with `test/__snapshots__/v1-compat.json`, recorded from
the server that apps in the wild were built against. Apps cannot be
redeployed when the server changes, so a diff there is a breaking change for
people already using them. Regenerate the snapshot (`UPDATE_SNAPSHOTS=1 npm
test`) only for a change every shipped SDK version handles, and say why in
the commit.

## Migrations

Add a new `migrations/NNN_name.sql`; never edit one that has shipped. They
are applied in order, by file name, each in a transaction, at every boot.

## Style

Plain Node, no framework, one runtime dependency. Comments say why, not what.
