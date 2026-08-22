// Fantasy Draft Compass — API server entry point.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import { stateRouter } from './routes/state.js';
import { paymentsRouter, stripeWebhookHandler } from './routes/payments.js';
import { adminRouter } from './routes/admin.js';
import { connectRouter } from './routes/connect.js';
import { feedbackRouter } from './routes/feedback.js';
import { trendsRouter } from './routes/trends.js';
import { refreshAll } from './jobs/refreshAll.js';

const app = express();

// Behind Render/Cloudflare there's a proxy in front of us; trust it so req.ip (used by the rate limiter)
// reflects the real client IP from X-Forwarded-For rather than the proxy's address.
app.set('trust proxy', 1);

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

// ---- Rate limiting (anti-abuse / basic DoS protection) ----
// A generous general limit so real users (even hammering the board during a live draft) are never
// throttled, but a runaway script or scraper is capped. The health check is exempt so uptime pingers and
// load balancers are never rate-limited.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,                     // 600 req/min per IP — well above normal drafting traffic
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
});
// A strict limit on auth endpoints to stop brute-force / credential-stuffing on login & signup.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,                      // 30 attempts / 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});
app.use('/api', generalLimiter);

app.get('/api/health', (_req, res) => res.json({ ok: true, season: config.activeSeason, env: config.env }));

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/adp', adpRouter);
app.use('/api/player-pack', playerPackRouter);
app.use('/api/projections', projectionsRouter);
app.use('/api/leagues', leaguesRouter);
app.use('/api/state', stateRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/connect', connectRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/trends', trendsRouter);

// fallback 404 for unknown api routes
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// error handler
app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'unhandled error');
  res.status(500).json({ error: 'Server error' });
});

// PROCESS-LEVEL SAFETY NET. A single unexpected error anywhere must never take the whole API down while
// people are mid-draft. We log and keep running rather than letting the process exit. (A process manager
// on the host will still restart us if the process ever does die.)
process.on('unhandledRejection', (reason) => {
  log.error({ reason: reason && reason.message ? reason.message : String(reason) }, 'unhandledRejection — kept alive');
});
process.on('uncaughtException', (err) => {
  log.error({ err: err && err.message ? err.message : String(err) }, 'uncaughtException — kept alive');
});
// Graceful shutdown: on a platform stop/restart, finish in-flight requests before exiting so no
// save is cut off mid-write.
let server;
function shutdown(sig) {
  log.info({ sig }, 'shutting down');
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref(); // hard cap so we don't hang forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server = app.listen(config.port, () => {
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
    // Draft-trends pool growth: harvest a fresh batch several times a day (in addition to the 4 AM full
    // refresh) so the "How the field drafts" pool broadens across the league graph steadily rather than
    // once a night. Each pass crawls the next slice of not-yet-visited users.
    cron.schedule('30 */4 * * *', async () => {
      try { const { harvestSleeperDrafts } = await import('./jobs/harvestSleeperDrafts.js'); log.info('cron: periodic harvest pass'); const r = await harvestSleeperDrafts(); log.info(r, 'cron: harvest pass done'); }
      catch (e) { log.error(e, 'cron periodic harvest failed'); }
    });
    // ⚠ DATABASE PRUNE — nightly, right after the full refresh. adp_observations grows with every harvest
    // pass, and on 2026-08-05 it filled the Postgres plan, suspended the database and took the whole site
    // down. pruneObservations has existed since then but was never actually scheduled, so nothing has been
    // trimming it. Keeps a trailing ADP_KEEP_DAYS window and a per-format floor of ADP_MIN_SAMPLE rows.
    cron.schedule('45 4 * * *', async () => {
      try {
        const { pruneObservations } = await import('./jobs/pruneObservations.js');
        log.info('cron: nightly adp_observations prune');
        const r = await pruneObservations();
        log.info(r, 'cron: prune done');
      } catch (e) { log.error(e, 'cron prune failed'); }
    });
    // WEEKLY BRIEF — Tuesday morning, after waivers have run and the new NFL week has rolled over. Emails
    // each linked user what needs attention in their leagues. No-ops unless RESEND_API_KEY is set.
    cron.schedule('0 13 * * 2', async () => {
      try {
        const { sendWeeklyBriefs } = await import('./jobs/weeklyBrief.js');
        log.info('cron: weekly brief send');
        const r = await sendWeeklyBriefs();
        log.info(r, 'cron: weekly brief done');
      } catch (e) { log.error(e, 'cron weekly brief failed'); }
    });
    log.info('in-process daily + midday + prune + weekly-brief cron scheduled');
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
    // Startup catch-up for the DRAFT TRENDS pool: if no drafts have been harvested yet (fresh DB, or the
    // trends feature just shipped), kick off a harvest a little after boot so the "How the field drafts"
    // data self-populates automatically — no admin shell command required. Staggered after the ADP pull so
    // the two don't hammer Sleeper at once. The daily 4 AM refresh keeps it growing from there.
    setTimeout(async () => {
      try {
        const { q } = await import('./lib/db.js');
        // One-time migration: earlier harvests mis-tagged rookie drafts as REDRAFT (the harvester's format
        // detection didn't recognize rookie drafts), which flooded the redraft bucket with rookies and left
        // the rookie/dynasty buckets empty. Purge that pool ONCE so it re-harvests with the corrected tags.
        // Guarded by an app_meta flag so it runs exactly once, automatically — no admin action.
        await q(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now())`).catch(() => {});
        const flag = 'harvest_league_retag_v2';
        const done = await q(`SELECT value FROM app_meta WHERE key=$1`, [flag]).catch(() => ({ rows: [] }));
        if (!done.rows.length) {
          log.info('startup migration: purging mis-tagged harvested drafts so they re-harvest with correct format keys');
          await q(`DELETE FROM adp_observations WHERE source='sleeper_harvest'`).catch((e) => log.error(e, 'purge adp_observations'));
          await q(`DELETE FROM harvested_drafts`).catch((e) => log.error(e, 'purge harvested_drafts'));
          // Reset the crawl frontier so the FULL league graph is re-walked — a purge alone would leave every
          // user marked 'crawled', so the re-harvest would only pick up a handful of newly-found users.
          await q(`UPDATE discovered_users SET crawled_at = NULL`).catch((e) => log.error(e, 'reset crawl frontier'));
          await q(`INSERT INTO app_meta (key, value) VALUES ($1, now()::text) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [flag]).catch(() => {});
          log.info('startup migration: purge complete — harvest will repopulate below');
        }
        const r = await q(`SELECT count(*)::int n FROM harvested_drafts`).catch(() => ({ rows: [{ n: 0 }] }));
        if (!r.rows[0] || r.rows[0].n === 0) {
          log.info('startup: no harvested drafts found — running one-time draft harvest for Trends');
          const { harvestSleeperDrafts } = await import('./jobs/harvestSleeperDrafts.js');
          await harvestSleeperDrafts();
          log.info('startup: draft harvest complete');
        }
      } catch (e) { log.error(e, 'startup harvest catch-up failed'); }
    }, 20000);
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

// Long-running admin jobs (full refresh, harvest) run SYNCHRONOUSLY inside a request and can take minutes.
// Node's defaults would cut the socket well before they finish, which the browser then reports as a generic
// network failure. Raise the server-side ceilings so a job that is genuinely working is allowed to complete.
// (headersTimeout must exceed requestTimeout, or Node closes the connection while the handler is still busy.)
server.requestTimeout = 10 * 60 * 1000;  // 10 min: allow a full re-crawl to finish
server.headersTimeout = 11 * 60 * 1000;  // must be > requestTimeout
server.keepAliveTimeout = 75 * 1000;     // > typical proxy idle timeout, avoids races on keep-alive reuse
server.setTimeout(0);                    // no blanket socket timeout; the two above govern instead

