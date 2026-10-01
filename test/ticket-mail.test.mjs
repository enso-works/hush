// The mails a ticket sends. No alert may put an install id or RevenueCat's id
// next to an email (AGENTS.md), and the dry-run mailer logs the address and
// subject, never the text, so a log check cannot see it. Here createTicket,
// userReply and adminReply run in this process, Resend's endpoint is
// answered by a stub, and each mail's text is read as it would have gone out.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { addApp, freshDatabase, startServer, uuid } from './helpers.mjs';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let db, tickets, pool;
const mails = [];

before(async () => {
  db = await freshDatabase('hush_mail');
  const srv = await startServer(db); // migrates the database
  await srv.stop();
  await addApp(db, 'braele', 'Braele');
  // Placeholders: the stub below answers for Resend, and nothing leaves this process.
  Object.assign(process.env, { DATABASE_URL: db.url, ALERT_EMAIL: 'ops@example.com', RESEND_API_KEY: 're_placeholder', MAIL_FROM: 'hush@example.com' });
  delete process.env.MAIL_DRY_RUN;
  delete process.env.REPLY_HINT;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.resend.com/emails');
    mails.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200 });
  };
  tickets = await import('../src/tickets.mjs');
  ({ pool } = await import('../src/db.mjs'));
});
after(async () => {
  await pool?.end();
  await db?.drop();
});

/** The mail the last call sent: alerts go out without being awaited. */
async function sent() {
  await new Promise((r) => setImmediate(r));
  return mails.at(-1);
}
const base = { app: 'braele', subject: null, message: 'The timer stops when the screen locks.', diag: { version: '2.3.0', build: '20', os: 'ios 18.6', device: 'iPhone17,1', pro: true }, kind: 'issue' };

describe('a ticket with an email: no install, no customer id in any mail', () => {
  test('sent by SDK 2.3.0, with a thread key', async () => {
    const t = await tickets.createTicket({ ...base, install: null, email: 'sam@example.com' });
    const alert = await sent();
    assert.equal(alert.to[0], 'ops@example.com');
    assert.equal(alert.reply_to, 'sam@example.com');
    assert.match(alert.text, /email: sam@example\.com/);
    assert.doesNotMatch(alert.text, /install:|customer:/);
    assert.doesNotMatch(alert.text, UUID);
    assert.ok(!alert.text.includes(t.thread));

    await tickets.userReply({ id: t.id, thread: t.thread, app: 'braele', body: 'Still broken.' });
    const reply = await sent();
    assert.match(reply.subject, /Reply on #/);
    assert.doesNotMatch(reply.text, /install:|customer:/);
    assert.doesNotMatch(reply.text, UUID);
    assert.ok(!reply.text.includes(t.thread));
  });

  test('sent by an older app with its install and RevenueCat id', async () => {
    const install = uuid();
    const t = await tickets.createTicket({ ...base, install, email: 'old@example.com', rcId: '$RCAnonymousID:old' });
    const alert = await sent();
    assert.match(alert.text, /email: old@example\.com/);
    assert.doesNotMatch(alert.text, /install:|customer:/);
    assert.ok(!alert.text.includes(install));
    assert.ok(!alert.text.includes('$RCAnonymousID'));

    await tickets.userReply({ id: t.id, install, app: 'braele', body: 'Any news?' });
    const reply = await sent();
    assert.doesNotMatch(reply.text, /install:|customer:/);
    assert.ok(!reply.text.includes(install));

    // The operator's answer, mailed to the person.
    await tickets.adminReply(t.id, 'Fixed in 2.0.2.');
    const answer = mails.at(-1);
    assert.equal(answer.to[0], 'old@example.com');
    assert.doesNotMatch(answer.text, UUID);
  });
});

test('a ticket without an email: the install and customer lines stay, the only way to place it', async () => {
  const install = uuid();
  const t = await tickets.createTicket({ ...base, install, email: null, rcId: '$RCAnonymousID:paid' });
  const alert = await sent();
  assert.equal(alert.reply_to, undefined);
  assert.match(alert.text, new RegExp(`install: ${install}`));
  assert.match(alert.text, /customer: \$RCAnonymousID:paid/);
  assert.match(alert.text, /email: \(none given\)/);

  await tickets.userReply({ id: t.id, install, app: 'braele', body: 'Thanks' });
  assert.match((await sent()).text, new RegExp(`install: ${install}`));
});
