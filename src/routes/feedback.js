// Public feedback endpoint — the site's contact form / "Report a bug" button posts here. Stored in the
// feedback table (read by admins in the inbox) AND, if email is configured, emailed to the admin notify
// list so bug reports reach you without checking the dashboard. No auth required (anyone can send), but a
// signed-in user's email is captured automatically so you can reply.
import { Router } from 'express';
import { q } from '../lib/db.js';

export const feedbackRouter = Router();

// Email a new report to admins via Resend's HTTP API (no SMTP/deps — just fetch). Configure in Render:
//   RESEND_API_KEY   — your Resend API key (https://resend.com; free tier is plenty for beta)
//   FEEDBACK_FROM    — a verified sender, e.g. "Fantasy Draft Compass <bugs@fantasydraftcompass.com>"
//   ADMIN_NOTIFY_EMAILS — comma-separated recipients, e.g. "rosetc16@gmail.com,trey.rose@pirates.com"
//                          (edit this in the Render dashboard anytime — no code change/redeploy of logic)
// If any are unset, we simply skip email (the report is still stored + visible in the admin inbox).
async function notifyAdmins({ id, email, category, message }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FEEDBACK_FROM;
  const to = (process.env.ADMIN_NOTIFY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!key || !from || !to.length) return;
  const subject = `[FDC ${category}] new report${email ? ` from ${email}` : ''}`;
  const body = [
    `Category: ${category}`,
    `From: ${email || '(not signed in / no email given)'}`,
    `Report ID: ${id}`,
    '',
    message,
    '',
    '— Reply directly to the sender above; this is an automated notification.',
  ].join('\n');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text: body, ...(email ? { reply_to: email } : {}) }),
    });
  } catch (e) { /* email is best-effort; never fail the submission over it */ }
}

feedbackRouter.post('/', async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (message.length > 5000) return res.status(400).json({ error: 'message too long' });
  const email = (req.user && req.user.email) || (req.body.email ? String(req.body.email).trim().toLowerCase() : null);
  const category = ['bug', 'idea', 'question', 'other'].includes(req.body.category) ? req.body.category : 'other';
  const { rows } = await q(
    `INSERT INTO feedback (email, category, message) VALUES ($1,$2,$3) RETURNING id, created_at`,
    [email, category, message]
  );
  const id = rows[0].id;
  notifyAdmins({ id, email, category, message }); // fire-and-forget; response doesn't wait on email
  res.json({ ok: true, id });
});
