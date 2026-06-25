// Public feedback endpoint — the site's contact form posts here. Stored in the feedback table and
// read by admins in the inbox. No auth required (anyone can send feedback), but if the user is
// signed in we capture their email automatically.
import { Router } from 'express';
import { q } from '../lib/db.js';

export const feedbackRouter = Router();

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
  res.json({ ok: true, id: rows[0].id });
});
