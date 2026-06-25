// Fantasy Draft Compass — API server entry point.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import cron from 'node-cron';

import { config } from './lib/config.js';
import { log } from './lib/log.js';
import { attachUser } from './lib/auth.js';

import { authRouter } from './routes/auth.js';
import { adpRouter } from './routes/adp.js';
import { playerPackRouter } from './routes/playerPack.js';
import { projectionsRouter } from './routes/projections.js';
import { leaguesRouter } from './routes/leagues.js';
import { paymentsRouter, stripeWebhookHandler } from './routes/payments.js';
import { adminRouter } from './routes/admin.js';
import { connectRouter } from './routes/connect.js';
import { feedbackRouter } from './routes/feedback.js';
import { refreshAll } from './jobs/refreshAll.js';

const app = express();

app.use(helmet());
// CORS: if CORS_ORIGINS is empty or contains "*", allow any origin (reflect it back). Otherwise
// allow only the listed origins. We reflect the specific origin rather than literally sending "*"
// so that credentialed requests also work.
const corsAllowAll = config.corsOrigins.length === 0 || config.corsOrigins.includes('*');
app.use(cors({
  origin: corsAllowAll ? true : config.corsOrigins,
  credentials: true,
}));
app.use(pinoHttp({ logger: log }));

// IMPORTANT: Stripe webhook signature verification needs the EXACT raw request body. So we mount
// a dedicated raw-body handler for just this one path, BEFORE the JSON parser, and we import the
// handler directly (not the whole router) so nothing else touches the body first.
app.post('/api/payments/webhook', express.raw({ type: '*/*' }), stripeWebhookHandler);

// JSON parser for everything else. We skip the webhook path so its raw body is never re-parsed.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhook') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});
app.use(attachUser);

app.get('/api/health', (_req, res) => res.json({ ok: true, season: config.activeSeason, env: config.env }));

app.use('/api/auth', authRouter);
app.use('/api/adp', adpRouter);
app.use('/api/player-pack', playerPackRouter);
app.use('/api/projections', projectionsRouter);
app.use('/api/leagues', leaguesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/connect', connectRouter);
app.use('/api/feedback', feedbackRouter);

// fallback 404 for unknown api routes
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// error handler
app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'unhandled error');
  res.status(500).json({ error: 'Server error' });
});

app.listen(config.port, () => {
  log.info(`FDC API listening on :${config.port} (${config.env})`);

  // OPTIONAL in-process scheduler. On platforms with their own Cron Jobs (Render/Railway), prefer
  // those and set DISABLE_INPROCESS_CRON=1. This is a convenience for single-instance hosting.
  if (process.env.DISABLE_INPROCESS_CRON !== '1') {
    // daily at 4:15am server time — full refresh
    cron.schedule('15 4 * * *', () => {
      log.info('cron: daily refreshAll starting');
      refreshAll().catch((e) => log.error(e, 'cron refreshAll failed'));
    });
    log.info('in-process daily cron scheduled (set DISABLE_INPROCESS_CRON=1 to use platform cron instead)');
  }
});
