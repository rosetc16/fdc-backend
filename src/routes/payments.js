// Payments via Stripe. Creates a Checkout Session for the season pass; the webhook marks the
// user paid when Stripe confirms. The webhook is the source of truth — never trust the client.
import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { log } from '../lib/log.js';

export const paymentsRouter = Router();
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

// Season pass expiry = the league-year cutoff (everyone renews together before next season).
function passExpiry() {
  return new Date(config.leagueYearCutoff);
}

// POST /api/payments/checkout  → { url }  (front-end redirects the user here)
paymentsRouter.post('/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const successUrl = req.body.successUrl || `${req.headers.origin || ''}/?paid=1`;
  const cancelUrl = req.body.cancelUrl || `${req.headers.origin || ''}/?canceled=1`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: config.stripe.priceId, quantity: 1 }],
      customer_email: req.user.email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { user_id: String(req.user.id) },
    });
    res.json({ url: session.url });
  } catch (e) {
    log.error({ err: e.message }, 'checkout failed');
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// Stripe webhook. MUST receive the raw body (wired with express.raw in server.js for this path).
// Stripe webhook handler. Exported standalone so server.js can mount it with a raw-body parser
// (signature verification requires the exact unparsed body). NOT added to the JSON-parsed router.
export async function stripeWebhookHandler(req, res) {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
  } catch (e) {
    log.warn({ err: e.message }, 'bad stripe signature');
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const userId = s.metadata?.user_id;
    if (userId) {
      await q('UPDATE users SET paid_until=$1 WHERE id=$2', [passExpiry(), Number(userId)]);
      log.info({ userId }, 'season pass activated');
    }
  }
  res.json({ received: true });
}
