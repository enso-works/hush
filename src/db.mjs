import pg from 'pg';

import { cfg } from './config.mjs';

// Small pool on purpose: this service shares one Postgres with every other app
// on the box, and its work is short single-statement queries. The timezone is
// pinned because every dashboard number is bucketed by day: with the session
// default, the same query would draw different bars depending on what TZ the
// container happened to start with.
export const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5, idleTimeoutMillis: 30_000, options: '-c timezone=UTC' });

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
