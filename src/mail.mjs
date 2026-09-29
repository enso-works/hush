// Resend over plain fetch. One request shape, no SDK, no dependency.
import { cfg, log } from './config.mjs';

export async function sendMail({ to, subject, text, replyTo }) {
  if (cfg.mailDryRun || !cfg.resendKey || !cfg.mailFrom || !to) {
    const reason = cfg.mailDryRun ? 'dry-run' : !cfg.resendKey ? 'no RESEND_API_KEY' : !cfg.mailFrom ? 'no MAIL_FROM' : 'no recipient';
    log.info('mail skipped', { to, subject, reason });
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.mailFrom, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('mail rejected', { to, status: res.status, body: (await res.text()).slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    // A ticket is already stored by the time this runs; a failed mail must
    // never fail the request the user is waiting on.
    log.warn('mail failed', { to, err: String(err?.message ?? err) });
    return false;
  }
}
