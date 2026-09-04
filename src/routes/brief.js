/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   UNSUBSCRIBING FROM THE WEEKLY BRIEF — the thing that has to exist before the first one is sent.
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   ⭐⭐⭐⭐ THE BRIEF IS OPT-IN. NOBODY IS EMAILED UNLESS THEY ASKED TO BE.
     Trey: "I don't think I want to send automated emails unless someone subscribes to them."
   That is the right call and it is stricter than the law requires, which is the point. The job was written
   to mail every linked paying user by default and offer a way out; it now mails only `brief_opt_in = TRUE`,
   a column that defaults to FALSE, so the Tuesday cron sends to NOBODY until somebody switches it on from
   their account page. Consent is a thing people give, not a thing they fail to withdraw.
   ⚠ THE PRACTICAL CASE IS THE SAME AS THE PRINCIPLED ONE: mailing only people who asked is the single
     largest input to a young domain's sending reputation, and this domain also sends PASSWORD RESETS —
     the one email a user genuinely cannot do without. Spam complaints against the brief would take those
     down with it.

   THE UNSUBSCRIBE STILL MATTERS, AND STILL LIVES HERE. Somebody who opted in has to be able to leave from
   the email itself, without hunting through an account page — and the first draft of this feature is
   exactly why: its only offer of a way out was a sentence reading "reply to this email to turn it off",
   with no column, no link and no handler behind it, so anyone who replied would have been mailed again
   seven days later. This file is what stops "you can stop it" from being another empty sentence.

   ⭐ TWO DOORS, ON PURPOSE, AND THE DIFFERENCE MATTERS.
     · ONE-CLICK (RFC 8058): the mail carries `List-Unsubscribe` + `List-Unsubscribe-Post`, so Gmail and
       Yahoo render their own native unsubscribe button and POST to it. Both have REQUIRED this of bulk
       senders since 2024 — without it the mail is likelier to be filed as spam whatever it says.
     · THE LINK IN THE BODY IS A **GET THAT CHANGES NOTHING**, showing a confirm button that POSTs.
       ⚠ THIS IS THE PART THAT IS EASY TO GET WRONG: corporate mail scanners and link-preview bots fetch
       every URL in an email. A GET that unsubscribes would silently opt people out who never clicked, and
       the symptom — "I stopped getting the brief and never asked to" — is indistinguishable from a bug in
       the sender. State changes go through POST; the GET only renders.

   ⭐ THE TOKEN IS AN HMAC, NOT A ROW. An unsubscribe link has to keep working forever, including from an
     email someone finds in a folder next February, so an expiring token in a table is the wrong shape —
     and a stored random token is a second thing to keep in sync with the user. `HMAC(user id)` under the
     server's own secret is stateless, unguessable, and constant. It authorises exactly one thing: turning
     this one address's brief off.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { Router } from 'express';
import crypto from 'crypto';
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';

export const briefRouter = Router();

/* The signing secret. JWT_SECRET is what the rest of the app authenticates with and is always present in
   any environment that can send mail at all. ⚠ If it is ever rotated, old unsubscribe links stop
   verifying — which fails CLOSED (the link says "we couldn't read that link, here is how else to stop"),
   never open, and never unsubscribes the wrong person. */
const secret = () => process.env.JWT_SECRET || process.env.SESSION_SECRET || 'fdc-brief-unsub';
export function unsubToken(userId) {
  return crypto.createHmac('sha256', secret()).update(`brief:${userId}`).digest('hex').slice(0, 32);
}
function tokenOk(userId, token) {
  const want = unsubToken(userId);
  const got = String(token || '');
  // Constant-time compare, and length-guarded because timingSafeEqual throws on a length mismatch.
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)); } catch { return false; }
}
export function unsubLink(userId, base) {
  const root = String(base || process.env.APP_URL || 'https://www.fantasydraftcompass.com').replace(/\/+$/, '');
  return `${root}/api/brief/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;
}

let columnEnsured = false;
export async function ensureBriefColumn() {
  if (columnEnsured) return;
  /* ⚠ DEFAULT FALSE IS THE WHOLE POLICY. A new column on an existing table backfills every row with the
     default, so this one silently subscribes nobody — which is exactly what is wanted, and would have been
     exactly wrong had the column been named the other way round. */
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS brief_opt_in BOOLEAN DEFAULT FALSE;').catch(() => {});
  columnEnsured = true;
}

// A whole page rather than JSON: this is opened in a mail client's browser by someone who is done with us,
// and the least we can do is answer in a sentence they can read.
const page = (title, body, tone = 'ok') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
 body{margin:0;background:#0B0F14;color:#E8EAED;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .card{max-width:460px;width:100%;background:#121820;border:1px solid ${tone === 'bad' ? '#F2655C' : '#22303F'};border-radius:14px;padding:26px}
 h1{font-size:19px;margin:0 0 10px}
 p{color:#9AA6B2;font-size:14.5px;margin:0 0 14px}
 button{font:inherit;font-size:14.5px;font-weight:700;background:#E0A63C;color:#151002;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
 a{color:#E0A63C}
</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;

/* GET — RENDERS, CHANGES NOTHING. See the header: a mail scanner fetching this must not unsubscribe
   anybody, so the actual change is behind the button's POST. */
briefRouter.get('/unsubscribe', async (req, res) => {
  const u = String(req.query.u || '');
  const t = String(req.query.t || '');
  res.type('html');
  if (!u || !tokenOk(u, t)) {
    return res.status(400).send(page('We couldn\'t read that link', `
      <p>The unsubscribe link looks incomplete or has been altered in transit — some mail clients wrap long
      URLs. Nothing has been changed.</p>
      <p>Open <a href="${process.env.APP_URL || 'https://www.fantasydraftcompass.com'}">Fantasy Draft Compass</a>
      and use “Report a bug” to tell us, and we'll turn the weekly brief off for you by hand.</p>`, 'bad'));
  }
  res.send(page('Stop the weekly brief?', `
    <p>You'll stop receiving the Tuesday email about your leagues. Everything else about your account —
    including your draft rooms and password-reset emails — is unaffected, and you can switch it back on any
    time from your account page.</p>
    <form method="POST" action="/api/brief/unsubscribe">
      <input type="hidden" name="u" value="${u.replace(/[^0-9a-zA-Z_-]/g, '')}">
      <input type="hidden" name="t" value="${t.replace(/[^0-9a-f]/g, '')}">
      <button type="submit">Yes, stop sending it</button>
    </form>`));
});

/* POST — the state change. Serves both the confirm button above and Gmail/Yahoo's native one-click
   button, which posts here directly with no body of its own beyond the query string. */
briefRouter.post('/unsubscribe', async (req, res) => {
  const b = req.body || {};
  const u = String(b.u || req.query.u || '');
  const t = String(b.t || req.query.t || '');
  const oneClick = !b.u; // came from the mail client's own button rather than our page
  if (!u || !tokenOk(u, t)) {
    if (oneClick) return res.status(400).json({ ok: false });
    return res.status(400).type('html').send(page('We couldn\'t read that link', '<p>Nothing has been changed.</p>', 'bad'));
  }
  try {
    await ensureBriefColumn();
    await q('UPDATE users SET brief_opt_in = FALSE WHERE id = $1', [u]);
    log.info({ user: u, oneClick }, 'weekly brief: unsubscribed');
  } catch (e) {
    log.error({ err: String(e && e.message) }, 'weekly brief: unsubscribe failed');
    if (oneClick) return res.status(500).json({ ok: false });
    return res.status(500).type('html').send(page('Something went wrong', `
      <p>We couldn't save that just now. Please try the link again in a moment — and if it keeps failing,
      use “Report a bug” in the app and we'll turn it off by hand.</p>`, 'bad'));
  }
  // ⚠ RFC 8058 wants a plain 200 for the one-click POST, not a page.
  if (oneClick) return res.json({ ok: true });
  res.type('html').send(page('Done — no more weekly briefs', `
    <p>You won't get the Tuesday email again. Your account, your leagues and your password-reset emails are
    all unchanged.</p>
    <p>Changed your mind? Turn it back on from your account page at
    <a href="${process.env.APP_URL || 'https://www.fantasydraftcompass.com'}">Fantasy Draft Compass</a>.</p>`));
});
