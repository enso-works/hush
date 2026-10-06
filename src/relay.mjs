// The push relay: bavrk runs it for the App Store hush app, so a server
// anyone hosts can notify that app without the APNs key of bavrk's team.
//
// The phone registers its token here and gets a pass: an HMAC of the token
// under this relay's secret. It hands the pass to the servers it signs up
// with, with a key of its own for each. A server sends the pass and what the
// push says, sealed with that key; the relay checks the pass and forwards a
// placeholder alert with the sealed blob, which the app's notification
// extension opens. The relay never sees what was written, and keeps nothing:
// no token, no pass, no server, only counts in its log.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { cfg } from './config.mjs';
import { apnsConfigured, deliver } from './push.mjs';

export const relayOn = () => cfg.relaySecret.length >= 32 && apnsConfigured();

const HEX = /^[0-9a-f]{64,200}$/;

export function passFor(token, sandbox) {
  return createHmac('sha256', cfg.relaySecret).update(`hush-push-v1|${token}|${sandbox ? 1 : 0}`).digest('base64url');
}

function passOk(token, sandbox, pass) {
  const want = Buffer.from(passFor(token, sandbox));
  const got = Buffer.from(String(pass));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** `{ token, sandbox }` from the app; a string naming what is wrong otherwise. */
export function parseRegistration(body) {
  const token = typeof body?.token === 'string' ? body.token.toLowerCase() : '';
  if (!HEX.test(token)) return 'token: an APNs device token, hex';
  if (body.sandbox != null && typeof body.sandbox !== 'boolean') return 'sandbox: true or false';
  return { token, sandbox: body.sandbox ?? false };
}

/** What a server sends; a string naming what is wrong otherwise. */
export function parseSend(body) {
  const reg = parseRegistration(body);
  if (typeof reg === 'string') return reg;
  if (typeof body.pass !== 'string') return 'pass: the one the phone got from this relay';
  // Apple takes 4 KB a push; the sealed part is the bulk of it.
  if (typeof body.sealed !== 'string' || !/^[A-Za-z0-9+/=]{40,3000}$/.test(body.sealed)) return 'sealed: base64, at most 3000 characters';
  if (body.label != null && (typeof body.label !== 'string' || body.label.length > 64)) return 'label: at most 64 characters';
  if (body.thread != null && (typeof body.thread !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.thread))) return 'thread: up to 64 letters, digits, - and _';
  if (body.category != null && body.category !== 'TICKET') return 'category: TICKET or nothing';
  return { ...reg, pass: body.pass, sealed: body.sealed, label: body.label ?? null, thread: body.thread ?? null, category: body.category ?? null };
}

/** Forwards a sealed push. `{ status }`: 200 sent, 403 a pass that is not this token's, 410 the token is gone. */
export async function relay(s) {
  if (!passOk(s.token, s.sandbox, s.pass)) return { status: 403 };
  const out = await deliver(s, {
    // What shows if the extension cannot open it (the phone forgot the key).
    aps: {
      alert: { title: 'hush', body: 'Something new on one of your servers.' },
      sound: 'default',
      'mutable-content': 1,
      ...(s.thread ? { 'thread-id': s.thread } : {}),
      ...(s.category ? { category: s.category } : {}),
    },
    sealed: s.sealed,
    ...(s.label ? { server: s.label } : {}),
  });
  return { status: out.ok ? 200 : out.dead ? 410 : 502, reason: out.reason };
}
