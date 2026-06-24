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
import { projectionsRouter } from './routes/projections.js';
import { leaguesRouter } from './routes/leagues.js';
import { paymentsRouter } from './routes/payments.js';
import { adminRouter } from './routes/admin.js';
import { refreshAll } from './jobs/refreshAll.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : true, credentials: true }));
app.use(pinoHttp({ logger: log }));

// IMPORTANT: Stripe webhook needs the RAW body for signature verification, so mount it BEFORE
// the JSON body parser, with express.raw for just that path.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  paymentsRouter.handle(req, res, next);
});

app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => res.json({ ok: true, season: config.activeSeason, env: config.env }));

app.use('/api/auth', authRouter);
app.use('/api/adp', adpRouter);
app.use('/api/projections', projectionsRouter);
app.use('/api/leagues', leaguesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);

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
