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

  // SELF-SUSTAINING DATA REFRESH. The app keeps its ADP/projections current on its own:
  //  • A daily full refresh (players, projections, published ADP, harvest, consensus).
  //  • A lighter published-ADP refresh midday so ADP tracks the market as it moves through the summer.
  //  • A one-time STARTUP CATCH-UP: if the DB has no published ADP yet (e.g. first deploy), pull it now
  //    so the board is correct without anyone having to click anything or open a shell.
  // Set DISABLE_INPROCESS_CRON=1 only if you've configured a platform cron to call these instead.
  if (process.env.DISABLE_INPROCESS_CRON !== '1') {
    // Daily full refresh (players, projections, published ADP, harvest, consensus, AND player news)
    // at 4:00 AM. Player news refreshes here automatically — no manual admin run needed.
    cron.schedule('0 4 * * *', () => {
      log.info('cron: daily refreshAll starting');
      refreshAll().catch((e) => log.error(e, 'cron refreshAll failed'));
    });
    // midday published-ADP-only refresh (fast; keeps ADP fresh as it moves)
    cron.schedule('15 16 * * *', async () => {
      try { const { refreshAdpOnly } = await import('./jobs/refreshAdpOnly.js'); log.info('cron: midday ADP refresh'); await refreshAdpOnly(); }
      catch (e) { log.error(e, 'cron midday ADP failed'); }
    });
    log.info('in-process daily + midday cron scheduled');
    // Startup catch-up: ensure published ADP exists shortly after boot (non-blocking).
    setTimeout(async () => {
      try {
        const { q } = await import('./lib/db.js');
        const r = await q(`SELECT count(*)::int n FROM adp_observations WHERE source='sleeper_published'`).catch(() => ({ rows: [{ n: 0 }] }));
        if (!r.rows[0] || r.rows[0].n === 0) {
          log.info('startup: no published ADP found — running one-time ADP pull');
          const { refreshAdpOnly } = await import('./jobs/refreshAdpOnly.js');
          await refreshAdpOnly();
          log.info('startup: ADP pull complete');
        }
      } catch (e) { log.error(e, 'startup ADP catch-up failed'); }
    }, 8000);
  }

  // ALWAYS-ON RECOVERY (runs regardless of DISABLE_INPROCESS_CRON): if the players or projections tables
  // are empty/tiny — e.g. a deploy broke the sync and emptied the board — repopulate automatically a few
  // seconds after boot. This is a safety net so a broken board self-heals without any manual admin action,
  // even when the scheduled in-process crons are turned off.
  setTimeout(async () => {
    try {
      const { q } = await import('./lib/db.js');
      const pc = await q(`SELECT count(*)::int n FROM players`).catch(() => ({ rows: [{ n: 0 }] }));
      const jc = await q(`SELECT count(*)::int n FROM projections`).catch(() => ({ rows: [{ n: 0 }] }));
      const nPlayers = pc.rows[0] ? pc.rows[0].n : 0;
      const nProj = jc.rows[0] ? jc.rows[0].n : 0;
      if (nPlayers < 500 || nProj < 200) {
        log.info({ nPlayers, nProj }, 'startup recovery: players/projections look empty — running full refresh');
        await refreshAll();
        log.info('startup recovery: full refresh complete');
      }
    } catch (e) { log.error(e, 'startup recovery failed'); }
  }, 10000);
});
