// ============================================================
//  GLITCH DEAL SCRAPER v3
//  Monitors: Amazon (Keepa), Best Buy, Walmart, Target, Nike,
//            Adidas, Farfetch, SSENSE, Woot, Dell, Newegg,
//            6pm, Nordstrom Rack, B&H Photo, OfferUp — every 10 min
//  Categories: Electronics, Laptops, TVs, Sneakers, Designer
//  Alerts:   Discord webhook (instant) + Email digest
//  Dashboard: http://localhost:3000
// ============================================================

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');

const db = require('./lib/db');
const notifier = require('./lib/notifier');
const { closeBrowser } = require('./scrapers/playwright-base');

// ── Scraper loading ───────────────────────────────────────────
function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (err) {
    console.error('[LOAD ERROR]', modulePath, err.message);
    const fallback = { scrape: async function() { return []; } };
    fallback.__loadError = err.message;
    return fallback;
  }
}

function normalizeScraperKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseListEnv(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => normalizeScraperKey(item))
      .filter(Boolean)
  );
}

// ── Config ────────────────────────────────────────────────────
const MIN_DISCOUNT_PCT = parseFloat(process.env.MIN_DISCOUNT_PCT || '40');
const SCRAPE_INTERVAL_MINS = parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '10', 10);
const PORT = parseInt(process.env.PORT || '3000', 10);
const SCRAPER_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || '90000', 10);
const SLOW_SCRAPER_MS = parseInt(process.env.SLOW_SCRAPER_MS || '45000', 10);
const SCRAPER_COOLDOWN_MINS = parseInt(process.env.SCRAPER_COOLDOWN_MINUTES || '60', 10);
const CORE_EMPTY_STREAK_LIMIT = parseInt(process.env.CORE_EMPTY_STREAK_LIMIT || '6', 10);
const EXPERIMENTAL_EMPTY_STREAK_LIMIT = parseInt(process.env.EXPERIMENTAL_EMPTY_STREAK_LIMIT || '4', 10);
const ERROR_STREAK_LIMIT = parseInt(process.env.SCRAPER_ERROR_STREAK_LIMIT || '3', 10);
const TIMEOUT_STREAK_LIMIT = parseInt(process.env.SCRAPER_TIMEOUT_STREAK_LIMIT || '2', 10);
const DISABLED_SCRAPER_KEYS = parseListEnv(process.env.DISABLED_SCRAPERS);
const WATCHDOG_ALERT_DEGRADED = String(process.env.WATCHDOG_ALERT_DEGRADED || '').toLowerCase() === 'true';

function scraperDef(name, modulePath, options = {}) {
  const module = safeRequire(modulePath);
  return {
    name,
    key: normalizeScraperKey(name),
    module,
    enabled: options.enabled !== false && !module.__loadError,
    tier: options.tier || 'core',
    timeoutMs: options.timeoutMs || SCRAPER_TIMEOUT_MS,
    autoCooldown: !!options.autoCooldown,
    loadError: module.__loadError || null,
  };
}

const scrapers = [
  scraperDef('Amazon', './scrapers/amazon', { enabled: !!process.env.KEEPA_API_KEY, timeoutMs: 120000 }),
  scraperDef('Best Buy', './scrapers/bestbuy'),
  scraperDef('Walmart', './scrapers/walmart'),
  scraperDef('Target', './scrapers/target', { tier: 'experimental', autoCooldown: true, timeoutMs: 45000 }),
  scraperDef('Nike', './scrapers/nike'),
  scraperDef('Adidas', './scrapers/adidas', { tier: 'experimental', autoCooldown: true, timeoutMs: 60000 }),
  scraperDef('Farfetch', './scrapers/farfetch', { tier: 'experimental', autoCooldown: true, timeoutMs: 60000 }),
  scraperDef('SSENSE', './scrapers/ssense', { tier: 'experimental', autoCooldown: true, timeoutMs: 60000 }),
  scraperDef('Woot', './scrapers/woot'),
  scraperDef('Dell', './scrapers/dell', { tier: 'experimental', autoCooldown: true, timeoutMs: 45000 }),
  scraperDef('Newegg', './scrapers/newegg'),
  scraperDef('6pm', './scrapers/sixpm'),
  scraperDef('Nordstrom Rack', './scrapers/nordstromrack'),
  scraperDef('B&H Photo', './scrapers/bhphoto', { tier: 'experimental', autoCooldown: true, timeoutMs: 60000 }),
  scraperDef('Slickdeals', './scrapers/slickdeals'),
  scraperDef('OfferUp', './scrapers/offerup', { tier: 'experimental', autoCooldown: true, timeoutMs: 45000 }),
];

// ── State ─────────────────────────────────────────────────────
let isRunning = false;
let lastRun = null;
let nextRun = null;
let runCount = 0;
let lastBatchNew = 0;
const runLog = []; // last 20 orchestrator runs

function createScraperState(scraper) {
  const manuallyDisabled = DISABLED_SCRAPER_KEYS.has(scraper.key);
  const disabledReason = manuallyDisabled
    ? 'Disabled by DISABLED_SCRAPERS'
    : (!scraper.enabled ? (scraper.loadError ? `Load error: ${scraper.loadError}` : 'Disabled by configuration') : null);
  return {
    name: scraper.name,
    key: scraper.key,
    tier: scraper.tier,
    enabled: scraper.enabled && !manuallyDisabled,
    manuallyDisabled,
    running: false,
    health: disabledReason ? 'disabled' : 'idle',
    lastStatus: disabledReason ? 'disabled' : 'idle',
    lastStartedAt: null,
    lastFinishedAt: null,
    lastNonZeroAt: null,
    lastDurationMs: 0,
    lastFound: 0,
    lastAlerted: 0,
    lastError: null,
    emptyStreak: 0,
    errorStreak: 0,
    timeoutStreak: 0,
    cooldownUntil: null,
    statusReason: disabledReason,
  };
}

const scraperStates = Object.fromEntries(scrapers.map((scraper) => [scraper.name, createScraperState(scraper)]));

// ── Helpers ───────────────────────────────────────────────────
function getEmptyStreakLimit(scraper) {
  return scraper.tier === 'experimental'
    ? EXPERIMENTAL_EMPTY_STREAK_LIMIT
    : CORE_EMPTY_STREAK_LIMIT;
}

function isCoolingDown(state) {
  return !!(state.cooldownUntil && new Date(state.cooldownUntil).getTime() > Date.now());
}

function computeNextRunAt(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setSeconds(0, 0);
  const minutes = next.getMinutes();
  const remainder = minutes % SCRAPE_INTERVAL_MINS;
  const addMinutes = remainder === 0 ? SCRAPE_INTERVAL_MINS : (SCRAPE_INTERVAL_MINS - remainder);
  next.setMinutes(minutes + addMinutes);
  return next.toISOString();
}

function getReportedNextRun() {
  return isRunning ? computeNextRunAt(new Date()) : nextRun;
}

function buildScraperSummary(scraper) {
  const state = scraperStates[scraper.name];
  return {
    name: scraper.name,
    tier: scraper.tier,
    enabled: scraper.enabled && !state.manuallyDisabled,
    health: state.health,
    status: state.lastStatus,
    running: state.running,
    timeoutMs: scraper.timeoutMs,
    cooldownUntil: state.cooldownUntil,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastNonZeroAt: state.lastNonZeroAt,
    lastDurationMs: state.lastDurationMs,
    lastFound: state.lastFound,
    lastAlerted: state.lastAlerted,
    lastError: state.lastError,
    emptyStreak: state.emptyStreak,
    errorStreak: state.errorStreak,
    timeoutStreak: state.timeoutStreak,
    statusReason: state.statusReason,
  };
}

function getScraperHealthCounts() {
  const summaries = scrapers.map(buildScraperSummary);
  return {
    healthy: summaries.filter((item) => item.health === 'healthy').length,
    degraded: summaries.filter((item) => item.health === 'degraded').length,
    failing: summaries.filter((item) => item.health === 'failing').length,
    cooldown: summaries.filter((item) => item.health === 'cooldown').length,
    disabled: summaries.filter((item) => item.health === 'disabled').length,
  };
}

function shouldSkipScraper(scraper) {
  const state = scraperStates[scraper.name];
  if (!scraper.enabled) {
    return { status: 'disabled', reason: 'Disabled by configuration' };
  }
  if (state.manuallyDisabled) {
    return { status: 'disabled', reason: 'Disabled by DISABLED_SCRAPERS' };
  }
  if (isCoolingDown(state)) {
    return { status: 'cooldown', reason: 'Cooling down after repeated weak runs' };
  }
  return null;
}

function deriveHealth(scraper, state) {
  if (!scraper.enabled || state.manuallyDisabled) return 'disabled';
  if (isCoolingDown(state)) return 'cooldown';
  if (state.running || state.lastStatus === 'running') return 'running';
  if (state.timeoutStreak >= TIMEOUT_STREAK_LIMIT) return 'failing';
  if (state.errorStreak >= ERROR_STREAK_LIMIT) return 'failing';
  if (state.lastStatus === 'timeout' || state.lastStatus === 'error') return 'degraded';
  if (state.emptyStreak >= getEmptyStreakLimit(scraper) || state.lastDurationMs >= SLOW_SCRAPER_MS) return 'degraded';
  if (state.lastStatus === 'ok' || state.lastStatus === 'empty') return 'healthy';
  return 'idle';
}

function maybeEnterCooldown(scraper, state) {
  if (!scraper.autoCooldown || isCoolingDown(state)) return false;

  const shouldCooldown =
    state.timeoutStreak >= TIMEOUT_STREAK_LIMIT ||
    state.errorStreak >= ERROR_STREAK_LIMIT ||
    state.emptyStreak >= getEmptyStreakLimit(scraper);

  if (!shouldCooldown) return false;

  const cooldownUntil = new Date(Date.now() + SCRAPER_COOLDOWN_MINS * 60 * 1000).toISOString();
  state.cooldownUntil = cooldownUntil;
  state.statusReason = `Auto cooldown until ${cooldownUntil}`;
  return true;
}

function buildWatchdogAlert(scraper, previousHealth, state) {
  const nextHealth = state.health;
  const summaryFields = [
    { name: 'Health', value: nextHealth, inline: true },
    { name: 'Status', value: state.lastStatus || 'unknown', inline: true },
    { name: 'Tier', value: scraper.tier, inline: true },
    { name: 'Found / Alerted', value: `${state.lastFound} / ${state.lastAlerted}`, inline: true },
    { name: 'Duration', value: `${Math.round(state.lastDurationMs / 1000)}s`, inline: true },
    { name: 'Streaks', value: `empty:${state.emptyStreak} error:${state.errorStreak} timeout:${state.timeoutStreak}`, inline: true },
  ];

  if (state.lastError) {
    summaryFields.push({ name: 'Error', value: state.lastError.slice(0, 200), inline: false });
  } else if (state.statusReason) {
    summaryFields.push({ name: 'Reason', value: state.statusReason.slice(0, 200), inline: false });
  }

  if ((previousHealth === 'degraded' || previousHealth === 'failing' || previousHealth === 'cooldown') && nextHealth === 'healthy') {
    return {
      title: `Scraper recovered: ${scraper.name}`,
      message: `**${scraper.name}** is healthy again and resumed normal output.`,
      color: 0x33CC66,
      fields: summaryFields,
    };
  }

  if (previousHealth === nextHealth) return null;

  if (nextHealth === 'failing') {
    return {
      title: `Scraper failing: ${scraper.name}`,
      message: `**${scraper.name}** is failing and needs attention.`,
      color: 0xFF3333,
      fields: summaryFields,
    };
  }

  if (nextHealth === 'cooldown') {
    return {
      title: `Scraper cooled down: ${scraper.name}`,
      message: `**${scraper.name}** was placed in cooldown after repeated weak runs.`,
      color: 0xFF8800,
      fields: summaryFields,
    };
  }

  if (nextHealth === 'degraded') {
    if (!WATCHDOG_ALERT_DEGRADED) return null;
    return {
      title: `Scraper degraded: ${scraper.name}`,
      message: `**${scraper.name}** is still running, but output quality has degraded.`,
      color: 0xFFD166,
      fields: summaryFields,
    };
  }

  return null;
}

function finalizeScraperState(scraper, outcome) {
  const state = scraperStates[scraper.name];
  const previousHealth = state.health;

  state.running = false;
  state.lastFinishedAt = new Date().toISOString();
  state.lastStatus = outcome.status;
  state.lastDurationMs = outcome.ms || 0;
  state.lastFound = outcome.found || 0;
  state.lastAlerted = outcome.alerted || 0;
  state.lastError = outcome.errorMessage || null;
  state.statusReason = outcome.reason || null;

  if (outcome.status === 'ok') {
    state.errorStreak = 0;
    state.timeoutStreak = 0;
    state.emptyStreak = 0;
    if (state.lastFound > 0) {
      state.lastNonZeroAt = state.lastFinishedAt;
    }
  } else if (outcome.status === 'empty') {
    state.errorStreak = 0;
    state.timeoutStreak = 0;
    state.emptyStreak += 1;
  } else if (outcome.status === 'timeout') {
    state.timeoutStreak += 1;
    state.errorStreak += 1;
  } else if (outcome.status === 'error') {
    state.timeoutStreak = 0;
    state.errorStreak += 1;
  }

  maybeEnterCooldown(scraper, state);
  state.health = deriveHealth(scraper, state);
  return buildWatchdogAlert(scraper, previousHealth, state);
}

async function runScraperWithBudget(scraper) {
  let timeoutId = null;
  let aborted = false;

  try {
    return await Promise.race([
      Promise.resolve().then(() => scraper.module.scrape(MIN_DISCOUNT_PCT, {
        isAborted: () => aborted,
      })),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          aborted = true;
          closeBrowser().catch(() => {});
          const err = new Error(`Timed out after ${scraper.timeoutMs}ms`);
          err.code = 'SCRAPER_TIMEOUT';
          reject(err);
        }, scraper.timeoutMs);
        if (typeof timeoutId.unref === 'function') timeoutId.unref();
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Main Scraper ──────────────────────────────────────────────
async function runScraper() {
  if (isRunning) {
    console.log('[Orchestrator] Already running — skipping this cycle');
    return;
  }

  isRunning = true;
  lastRun = new Date().toISOString();
  nextRun = computeNextRunAt(new Date());
  runCount += 1;

  const runSummary = {
    run: runCount,
    startedAt: lastRun,
    scrapers: {},
    totalNew: 0,
    errors: [],
    watchdogs: [],
  };

  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Scrape run #' + runCount + ' — ' + new Date().toLocaleString());
  console.log('═'.repeat(60));

  const allNewDeals = [];
  const watchdogAlerts = [];

  try {
    for (const scraper of scrapers) {
      const state = scraperStates[scraper.name];
      const skip = shouldSkipScraper(scraper);

      if (skip) {
        state.running = false;
        state.lastStatus = skip.status;
        state.statusReason = skip.reason;
        state.health = deriveHealth(scraper, state);
        runSummary.scrapers[scraper.name] = {
          status: skip.status,
          health: state.health,
          reason: skip.reason,
          found: 0,
          alerted: 0,
          ms: 0,
        };
        db.recordScraperRun({
          runNumber: runCount,
          scraperName: scraper.name,
          tier: scraper.tier,
          status: skip.status,
          found: 0,
          alerted: 0,
          durationMs: 0,
          errorMessage: null,
          details: { health: state.health, reason: skip.reason },
        });
        console.log('[' + scraper.name + '] ⏭  Skipped (' + skip.reason + ')');
        continue;
      }

      console.log('\n[' + scraper.name + '] Starting...');
      const scraperStart = Date.now();
      state.running = true;
      state.health = 'running';
      state.lastStartedAt = new Date().toISOString();
      state.lastStatus = 'running';
      state.lastError = null;
      state.statusReason = null;

      try {
        const rawDeals = await runScraperWithBudget(scraper);
        const safeDeals = Array.isArray(rawDeals) ? rawDeals : [];
        const confirmedDeals = [];

        for (const deal of safeDeals) {
          try {
            const retailer = deal.retailer || deal.storeName || scraper.name;
            const productId = deal.productId || (retailer + '_' + Buffer.from(deal.url || deal.name || retailer).toString('base64').slice(0, 20));
            const name = deal.name;
            const url = deal.url || '';
            const imageUrl = deal.imageUrl || deal.image || null;
            const price = deal.price;
            const normalPrice = deal.normalPrice || deal.originalPrice || null;
            const discountPct = deal.discountPct || deal.discount || 0;

            if (!name || !price) continue;

            const normalizedDeal = {
              retailer,
              productId,
              name,
              url,
              imageUrl,
              price,
              normalPrice,
              discountPct,
              source: deal.source || retailer,
            };

            const { productDbId, avgPrice, dataPoints } = db.savePrice({
              retailer,
              productId,
              name,
              url,
              imageUrl,
              price,
            });

            if (db.hasRecentAlert(productDbId)) continue;

            let confirmedDiscount = discountPct;
            let confirmedNormal = normalPrice;

            if (avgPrice && dataPoints >= 3) {
              const historyDiscount = ((avgPrice - price) / avgPrice) * 100;
              if (historyDiscount >= MIN_DISCOUNT_PCT) {
                confirmedDiscount = historyDiscount;
                confirmedNormal = avgPrice;
              } else if (discountPct < MIN_DISCOUNT_PCT) {
                continue;
              }
            }

            if (confirmedDiscount < MIN_DISCOUNT_PCT) continue;

            db.recordAlert({
              productDbId,
              glitchPrice: price,
              normalPrice: confirmedNormal || normalPrice,
              discountPct: confirmedDiscount,
              retailer,
            });

            confirmedDeals.push({
              ...normalizedDeal,
              discountPct: confirmedDiscount,
              normalPrice: confirmedNormal || normalPrice,
              dataPoints,
            });
          } catch (err) {
            console.error('[' + scraper.name + '] Error processing deal:', err.message);
          }
        }

        const ms = Date.now() - scraperStart;
        const status = safeDeals.length > 0 ? 'ok' : 'empty';
        const watchdog = finalizeScraperState(scraper, {
          status,
          found: safeDeals.length,
          alerted: confirmedDeals.length,
          ms,
          reason: safeDeals.length === 0 ? 'Returned no candidate deals' : null,
        });

        runSummary.scrapers[scraper.name] = {
          status,
          health: scraperStates[scraper.name].health,
          found: safeDeals.length,
          alerted: confirmedDeals.length,
          ms,
          emptyStreak: scraperStates[scraper.name].emptyStreak,
        };

        db.recordScraperRun({
          runNumber: runCount,
          scraperName: scraper.name,
          tier: scraper.tier,
          status,
          found: safeDeals.length,
          alerted: confirmedDeals.length,
          durationMs: ms,
          details: {
            health: scraperStates[scraper.name].health,
            emptyStreak: scraperStates[scraper.name].emptyStreak,
            errorStreak: scraperStates[scraper.name].errorStreak,
            timeoutStreak: scraperStates[scraper.name].timeoutStreak,
            cooldownUntil: scraperStates[scraper.name].cooldownUntil,
          },
        });

        if (watchdog) {
          watchdogAlerts.push(watchdog);
          runSummary.watchdogs.push(watchdog.title);
        }

        allNewDeals.push(...confirmedDeals);
        console.log('[' + scraper.name + '] ✅ ' + safeDeals.length + ' raw → ' + confirmedDeals.length + ' confirmed glitches');
      } catch (err) {
        const ms = Date.now() - scraperStart;
        const status = err.code === 'SCRAPER_TIMEOUT' ? 'timeout' : 'error';
        const reason = err.code === 'SCRAPER_TIMEOUT'
          ? `Timed out after ${scraper.timeoutMs}ms`
          : err.message;
        const watchdog = finalizeScraperState(scraper, {
          status,
          found: 0,
          alerted: 0,
          ms,
          errorMessage: err.message,
          reason,
        });
        const msg = '[' + scraper.name + '] ❌ ' + reason;

        console.error(msg);
        runSummary.scrapers[scraper.name] = {
          status,
          health: scraperStates[scraper.name].health,
          error: err.message,
          ms,
        };
        runSummary.errors.push(msg);

        db.recordScraperRun({
          runNumber: runCount,
          scraperName: scraper.name,
          tier: scraper.tier,
          status,
          found: 0,
          alerted: 0,
          durationMs: ms,
          errorMessage: err.message,
          details: {
            health: scraperStates[scraper.name].health,
            emptyStreak: scraperStates[scraper.name].emptyStreak,
            errorStreak: scraperStates[scraper.name].errorStreak,
            timeoutStreak: scraperStates[scraper.name].timeoutStreak,
            cooldownUntil: scraperStates[scraper.name].cooldownUntil,
          },
        });

        if (watchdog) {
          watchdogAlerts.push(watchdog);
          runSummary.watchdogs.push(watchdog.title);
        }
      }
    }

    if (allNewDeals.length > 0) {
      console.log('\n🚨 Sending ' + allNewDeals.length + ' alert(s)...');
      for (const deal of allNewDeals) {
        await notifier.sendDiscordAlert(deal);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await notifier.sendEmailDigest(allNewDeals);
    }

    if (watchdogAlerts.length > 0) {
      console.log('\n🛠 Sending ' + watchdogAlerts.length + ' watchdog alert(s)...');
      for (const alert of watchdogAlerts) {
        await notifier.sendSystemAlert(alert);
      }
    }

    runSummary.totalNew = allNewDeals.length;
    runSummary.endedAt = new Date().toISOString();
    lastBatchNew = allNewDeals.length;
    runSummary.health = getScraperHealthCounts();

    runLog.unshift(runSummary);
    if (runLog.length > 20) runLog.pop();

    if (runCount % 144 === 0) db.pruneOldData();

    console.log('\n✅ Run #' + runCount + ' complete — ' + allNewDeals.length + ' new glitch deal(s)');
    console.log('═'.repeat(60) + '\n');
  } finally {
    isRunning = false;
    nextRun = computeNextRunAt(new Date());
  }
}

// ── Express Dashboard & API ───────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/alerts', (req, res) => {
  try {
    res.json(db.getRecentAlerts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  const dbStats = db.getStats();
  const health = getScraperHealthCounts();
  res.json({
    ...dbStats,
    isRunning,
    lastRun,
    nextRun: getReportedNextRun(),
    runCount,
    lastBatchNew,
    minDiscount: MIN_DISCOUNT_PCT,
    intervalMins: SCRAPE_INTERVAL_MINS,
    scraperTimeoutMs: SCRAPER_TIMEOUT_MS,
    enabledScrapers: scrapers.filter((scraper) => scraper.enabled && !scraperStates[scraper.name].manuallyDisabled).map((scraper) => scraper.name),
    scraperHealth: health,
    discordLinked: !!process.env.DISCORD_WEBHOOK_URL,
    emailLinked: !!process.env.EMAIL_USER,
    keepaLinked: !!process.env.KEEPA_API_KEY,
  });
});

app.get('/api/runs', (req, res) => res.json(runLog));

app.get('/api/scrapers', (req, res) => {
  res.json(scrapers.map(buildScraperSummary));
});

app.get('/api/scraper-runs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 250);
  try {
    res.json(db.getRecentScraperRuns(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape', (req, res) => {
  if (isRunning) {
    return res.json({ success: false, message: 'Already running' });
  }
  runScraper().catch(console.error);
  res.json({ success: true, message: 'Scrape started' });
});

app.get('/health', (req, res) => {
  const health = getScraperHealthCounts();
  const status = (health.failing > 0 || health.degraded > 0 || health.cooldown > 0) ? 'degraded' : 'ok';
  res.json({
    status,
    uptime: Math.round(process.uptime()),
    isRunning,
    lastRun,
    nextRun: getReportedNextRun(),
    scraperHealth: health,
  });
});

// ── Start ─────────────────────────────────────────────────────
const cronExpr = '*/' + SCRAPE_INTERVAL_MINS + ' * * * *';
cron.schedule(cronExpr, () => {
  runScraper().catch(console.error);
});

app.listen(PORT, () => {
  nextRun = new Date(Date.now() + 15000).toISOString();

  console.log('\n' + '═'.repeat(60));
  console.log('  🔥 GLITCH DEAL SCRAPER v3 — ONLINE');
  console.log('═'.repeat(60));
  console.log('  Dashboard  → http://localhost:' + PORT);
  console.log('  Interval   → every ' + SCRAPE_INTERVAL_MINS + ' minutes');
  console.log('  Min Disc.  → ' + MIN_DISCOUNT_PCT + '% off');
  console.log('  Timeout    → ' + Math.round(SCRAPER_TIMEOUT_MS / 1000) + 's per scraper');
  console.log('  Discord    → ' + (process.env.DISCORD_WEBHOOK_URL ? '✅ connected' : '❌ NOT SET'));
  console.log('  Email      → ' + (process.env.EMAIL_USER ? '✅ connected' : '❌ not set (optional)'));
  console.log('  Keepa/Amzn → ' + (process.env.KEEPA_API_KEY ? '✅ connected' : '⚠️  not set (Amazon disabled)'));
  console.log('  Scrapers   → ' + scrapers.filter((scraper) => scraper.enabled && !scraperStates[scraper.name].manuallyDisabled).map((scraper) => scraper.name).join(', '));
  console.log('═'.repeat(60) + '\n');

  setTimeout(() => {
    runScraper().catch(console.error);
  }, 15000);
});

process.on('SIGTERM', async () => {
  console.log('\n[Shutdown] Closing browser...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n[Shutdown] Closing browser...');
  await closeBrowser();
  process.exit(0);
});
