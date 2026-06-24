// Centralized config from environment. Fails loud on missing critical secrets in production.
// dotenv is only used to load a local .env file in development; on hosting platforms the env vars
// are provided directly, so we load it best-effort and never crash if it isn't installed.
try { await import('dotenv/config'); } catch { /* dotenv optional — env comes from the platform */ }

const required = (key, fallback) => {
  const v = process.env[key] ?? fallback;
  if (v === undefined && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  databaseUrl: required('DATABASE_URL', 'postgres://fdc:fdc@localhost:5432/fdc'),

  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret'),
  jwtExpires: process.env.JWT_EXPIRES || '30d',
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceId: process.env.STRIPE_PRICE_ID || '',
  },
  seasonPassCents: Number(process.env.SEASON_PASS_CENTS || 1999),

  sleeperBase: process.env.SLEEPER_BASE || 'https://api.sleeper.app/v1',
  activeSeason: Number(process.env.ACTIVE_SEASON || new Date().getFullYear()),
  leagueYearCutoff: process.env.LEAGUE_YEAR_CUTOFF || `${new Date().getFullYear() + 1}-03-01`,

  harvest: {
    maxCallsPerMin: Number(process.env.SLEEPER_MAX_CALLS_PER_MIN || 800),
    batch: Number(process.env.HARVEST_BATCH || 200),
  },
};

export const isAdminEmail = (email) =>
  !!email && config.adminEmails.includes(String(email).trim().toLowerCase());
