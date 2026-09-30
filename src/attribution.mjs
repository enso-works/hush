// Apple's ad attribution, as copies of the postbacks the winning ad network
// gets: SKAdNetwork (Info.plist NSAdvertisingAttributionReportEndpoint) and
// AdAttributionKit (AdAttributionKit.AttributionCopyEndpoint). The device
// posts them to the app's registrable domain, under
//   /.well-known/skadnetwork/report-attribution/
//   /.well-known/appattribution/report-attribution/
// which the proxy sends here. A postback names a campaign (source-identifier)
// and a conversion value the app set, never an install or a person.
//
// Verified with Apple's published keys, and kept either way: an unverified
// one is stored with verified = false and never counted, so a forged postback
// costs a row and changes nothing.
import { createPublicKey, verify } from 'node:crypto';

import { appOfStoreId } from './catalog.mjs';
import { q } from './db.mjs';

const key = (b64) => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

// SKAdNetwork 2.1 and later, and AdAttributionKit's production key.
const APPLE = key('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWdp8GPcGqmhgzEFj9Z2nSpQVddayaPe4FMzqM9wib1+aHaaIzoHoLN9zW4K8y4SPykE3YVK3sVqW6Af0lfx3gg==');
// AdAttributionKit's keys by `kid`: production, and the two development ones
// (end-to-end testing, and Settings > Developer > Development Postbacks).
const AAK_KEYS = {
  'apple-cas-identifier/0': { key: APPLE, development: false },
  'apple-development-identifier/0': {
    key: key('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELeEDzpJEP+/qRSE5hJVC1p1J0ssUnQGMzBBbvnACBok8OVGGLgxL0myrKiy6lvRtSlLRsWit87i+vftD8AEqeQ=='),
    development: true,
  },
  'apple-development-identifier/1': {
    key: key('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8YzdO7eM97s/IJ25kdW5CZ3A14USE5IJ5Ha/vhWaxI6UBI1ZxCEvjrKxVluVGe6qWwF1BDFq+QHqKfH5u+wxHQ=='),
    development: true,
  },
};

const SEPARATOR = '⁣';

/** The signed part of an SKAdNetwork postback: its fields in Apple's order, absent ones left out with their separator. */
export function skanMessage(p) {
  const v4 = parseFloat(p.version) >= 4;
  const fields = v4
    ? ['version', 'ad-network-id', 'source-identifier', 'app-id', 'transaction-id', 'redownload', 'source-app-id|source-domain', 'fidelity-type', 'did-win', 'postback-sequence-index']
    : ['version', 'ad-network-id', 'campaign-id', 'app-id', 'transaction-id', 'redownload', 'source-app-id', 'fidelity-type', 'did-win'];
  const parts = [];
  for (const f of fields) {
    const k = f.split('|').find((x) => p[x] !== undefined && p[x] !== null);
    if (k) parts.push(String(p[k]));
  }
  return parts.join(SEPARATOR);
}

function verifySkan(p) {
  try {
    return verify('sha256', Buffer.from(skanMessage(p), 'utf8'), APPLE, Buffer.from(String(p['attribution-signature'] ?? ''), 'base64'));
  } catch {
    return false;
  }
}

/** A compact JWS from AdAttributionKit: its payload, and whether Apple's key for its `kid` signed it. */
export function readJws(jws) {
  const [h, p, s] = String(jws ?? '').split('.');
  if (!h || !p || !s) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const known = AAK_KEYS[header?.kid];
  let ok = false;
  if (known && header.alg === 'ES256') {
    try {
      ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: known.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    } catch {
      ok = false;
    }
  }
  return { payload, verified: ok, development: known?.development ?? false };
}

const str = (v, n = 120) => (v === undefined || v === null ? null : String(v).slice(0, n));
const int = (v) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** An SKAdNetwork postback copy as a row. */
export function skanRow(body) {
  const verified = verifySkan(body);
  return {
    dedupe: `skan:${str(body['transaction-id'], 80)}`,
    kind: 'skan',
    apple_app_id: int(body['app-id']),
    verified,
    // SKAN test postbacks (Xcode, the developer tool) come with source-app-id 0.
    development: body['source-app-id'] === 0,
    version: str(body.version, 8),
    ad_network: str(body['ad-network-id']),
    source_identifier: str(body['source-identifier'] ?? body['campaign-id'], 8),
    conversion_value: int(body['conversion-value']),
    coarse_value: str(body['coarse-conversion-value'], 8),
    sequence: int(body['postback-sequence-index']) ?? 0,
    did_win: bool(body['did-win']),
    redownload: bool(body.redownload),
    conversion_type: body.redownload === true ? 'redownload' : 'download',
    interaction: body['fidelity-type'] === 1 ? 'click' : body['fidelity-type'] === 0 ? 'view' : null,
    fidelity: int(body['fidelity-type']),
    source_app: str(body['source-app-id'], 20),
    source_domain: str(body['source-domain']),
    country: str(body['country-code'], 2),
    raw: body,
  };
}

/** An AdAttributionKit postback copy as a row: the JWS is signed; what sits beside it (the conversion values) is not. */
export function aakRow(body) {
  const jws = readJws(body['jws-string']);
  const p = jws?.payload ?? {};
  return {
    dedupe: `aak:${str(p['postback-identifier'], 80)}`,
    kind: 'aak',
    apple_app_id: int(p['advertised-item-identifier']),
    verified: jws?.verified ?? false,
    development: jws?.development ?? false,
    version: null,
    ad_network: str(p['ad-network-identifier']),
    source_identifier: str(p['source-identifier'], 8),
    conversion_value: int(body['conversion-value']),
    coarse_value: str(body['coarse-conversion-value'], 8),
    sequence: int(p['postback-sequence-index']) ?? 0,
    did_win: bool(p['did-win']),
    redownload: p['conversion-type'] === 'redownload',
    // Apple's prose says "reengagement", its signed sample "re-engagement".
    conversion_type: str(p['conversion-type'], 20)?.replace('reengagement', 're-engagement') ?? null,
    interaction: str(body['ad-interaction-type'], 10),
    fidelity: null,
    source_app: str(p['publisher-item-identifier'], 20),
    source_domain: null,
    country: str(body['country-code'], 2),
    raw: body,
  };
}

const COLUMNS = [
  'dedupe', 'kind', 'app', 'apple_app_id', 'verified', 'development', 'version', 'ad_network', 'source_identifier', 'conversion_value',
  'coarse_value', 'sequence', 'did_win', 'redownload', 'conversion_type', 'interaction', 'fidelity', 'source_app', 'source_domain', 'country', 'raw',
];

/** Stores a postback copy; a retry of one already stored is a no-op. Returns whether it was new. */
export async function storePostback(row) {
  if (row.dedupe.endsWith(':null')) return false;
  const withApp = { ...row, app: row.apple_app_id ? appOfStoreId(row.apple_app_id) : null, raw: JSON.stringify(row.raw) };
  const { rowCount } = await q(
    `INSERT INTO postbacks (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (dedupe) DO NOTHING`,
    COLUMNS.map((c) => withApp[c] ?? null),
  );
  return rowCount === 1;
}

/**
 * Postbacks for one app over a period, verified only: production ones, or
 * with `development` Apple's test ones. Per ad network and campaign
 * (source-identifier), how many installs (first postbacks), redownloads, and
 * how the first conversion values spread; and the values over all.
 */
export async function postbackSummary({ app, days, development = false }) {
  const scope = `app = $1 AND verified AND development = $3 AND received_at >= now() - make_interval(days => $2)`;
  const { rows: campaigns } = await q(
    `SELECT kind, ad_network, source_identifier,
            count(*) FILTER (WHERE sequence = 0)::int AS installs,
            count(*) FILTER (WHERE sequence = 0 AND redownload)::int AS redownloads,
            count(*) FILTER (WHERE sequence = 0 AND interaction = 'view')::int AS views,
            max(received_at) AS last
     FROM postbacks WHERE ${scope}
     GROUP BY 1, 2, 3
     -- Later postbacks carry only the campaign's first two digits: counted in
     -- the values below, not as campaigns of their own.
     HAVING count(*) FILTER (WHERE sequence = 0) > 0
     ORDER BY installs DESC, last DESC LIMIT 50`,
    [app, days, development],
  );
  const { rows: values } = await q(
    `SELECT sequence, conversion_value, coarse_value, count(*)::int AS n
     FROM postbacks WHERE ${scope}
     GROUP BY 1, 2, 3
     ORDER BY 1, 2 NULLS LAST, array_position(ARRAY['low', 'medium', 'high'], coarse_value)`,
    [app, days, development],
  );
  const { rows: unverified } = await q(
    `SELECT count(*)::int AS n FROM postbacks WHERE app = $1 AND NOT verified AND received_at >= now() - make_interval(days => $2)`,
    [app, days],
  );
  return { campaigns, values, unverified: unverified[0].n };
}
