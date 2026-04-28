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

function parseNumberMapEnv(value) {
  const map = new Map();
  for (const entry of String(value || '').split(',')) {
    const [rawKey, rawValue] = entry.split('=');
    const key = normalizeScraperKey(rawKey);
    const parsed = Number.parseFloat(rawValue);
    if (!key || Number.isNaN(parsed)) continue;
    map.set(key, parsed);
  }
  return map;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, '');
}

// ── Config ────────────────────────────────────────────────────
const MIN_DISCOUNT_PCT = parseFloat(process.env.MIN_DISCOUNT_PCT || '40');
const MIN_ALERT_SCORE = parseFloat(process.env.MIN_ALERT_SCORE || '0');
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
const DEFAULT_EXPERIMENTAL_CADENCE_RUNS = toPositiveInt(process.env.EXPERIMENTAL_SCRAPER_CADENCE_RUNS || '3', 3);
const DEFAULT_CORE_CADENCE_RUNS = toPositiveInt(process.env.CORE_SCRAPER_CADENCE_RUNS || '1', 1);
const RETAILER_MIN_DISCOUNTS = parseNumberMapEnv(process.env.RETAILER_MIN_DISCOUNTS);
const SCRAPER_RUN_INTERVALS = parseNumberMapEnv(process.env.SCRAPER_RUN_INTERVALS);
const PUBLIC_BASE_URL = normalizePublicBaseUrl(
  process.env.PUBLIC_BASE_URL ||
  process.env.APP_BASE_URL ||
  process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
);

const RETAILER_STRATEGIES = {
  amazon:          { thresholdPct: 32, cadenceRuns: 1, trustScore: 26, focusLabel: 'Conversion Core' },
  bestbuy:         { thresholdPct: 44, cadenceRuns: 1, trustScore: 18, focusLabel: 'Electronics Core' },
  walmart:         { thresholdPct: 52, cadenceRuns: 2, trustScore: 14, focusLabel: 'Blocked Often' },
  target:          { thresholdPct: 56, cadenceRuns: 4, trustScore: 10, focusLabel: 'Experimental' },
  nike:            { thresholdPct: 52, cadenceRuns: 2, trustScore: 16, focusLabel: 'Sneaker Core' },
  adidas:          { thresholdPct: 58, cadenceRuns: 3, trustScore: 12, focusLabel: 'Experimental' },
  farfetch:        { thresholdPct: 58, cadenceRuns: 3, trustScore: 13, focusLabel: 'Luxury Experimental' },
  ssense:          { thresholdPct: 58, cadenceRuns: 3, trustScore: 13, focusLabel: 'Luxury Experimental' },
  woot:            { thresholdPct: 38, cadenceRuns: 1, trustScore: 17, focusLabel: 'High Velocity' },
  dell:            { thresholdPct: 55, cadenceRuns: 4, trustScore: 9,  focusLabel: 'Experimental' },
  newegg:          { thresholdPct: 34, cadenceRuns: 1, trustScore: 24, focusLabel: 'Electronics Core' },
  '6pm':           { thresholdPct: 50, cadenceRuns: 2, trustScore: 14, focusLabel: 'Apparel Core' },
  nordstromrack:   { thresholdPct: 56, cadenceRuns: 2, trustScore: 14, focusLabel: 'Apparel Core' },
  bhphoto:         { thresholdPct: 44, cadenceRuns: 3, trustScore: 12, focusLabel: 'Experimental' },
  slickdeals:      { thresholdPct: 35, cadenceRuns: 1, trustScore: 25, focusLabel: 'Aggregator Core' },
  offerup:         { thresholdPct: 65, cadenceRuns: 4, trustScore: 8,  focusLabel: 'Low Signal' },
};

function getRetailerStrategy(name) {
  const key = normalizeScraperKey(name);
  const base = RETAILER_STRATEGIES[key] || {};
  const thresholdOverride = RETAILER_MIN_DISCOUNTS.get(key);
  const cadenceOverride = SCRAPER_RUN_INTERVALS.get(key);
  const thresholdPct = thresholdOverride ?? base.thresholdPct ?? MIN_DISCOUNT_PCT;
  const cadenceBase = cadenceOverride ?? base.cadenceRuns;

  return {
    key,
    thresholdPct,
    cadenceRuns: clamp(
      Math.round(cadenceBase ?? 1),
      1,
      12
    ),
    trustScore: base.trustScore ?? 12,
    focusLabel: base.focusLabel || 'General',
  };
}

function scraperDef(name, modulePath, options = {}) {
  const module = safeRequire(modulePath);
  const strategy = getRetailerStrategy(name);
  const tier = options.tier || 'core';
  return {
    name,
    key: normalizeScraperKey(name),
    module,
    enabled: options.enabled !== false && !module.__loadError,
    tier,
    timeoutMs: options.timeoutMs || SCRAPER_TIMEOUT_MS,
    autoCooldown: !!options.autoCooldown,
    loadError: module.__loadError || null,
    thresholdPct: options.thresholdPct || strategy.thresholdPct,
    cadenceRuns: clamp(
      Math.round(options.cadenceRuns || strategy.cadenceRuns || (tier === 'experimental' ? DEFAULT_EXPERIMENTAL_CADENCE_RUNS : DEFAULT_CORE_CADENCE_RUNS)),
      1,
      12
    ),
    candidateDiscountPct: clamp(
      Math.round(options.candidateDiscountPct || Math.max(25, (options.thresholdPct || strategy.thresholdPct) - 10)),
      20,
      95
    ),
    trustScore: options.trustScore ?? strategy.trustScore,
    focusLabel: options.focusLabel || strategy.focusLabel,
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

function computeScraperNextEligibleRun(scraper) {
  let candidateRun = Math.max(1, runCount + 1);
  while (!isScraperDue(scraper, candidateRun)) {
    candidateRun += 1;
  }
  return candidateRun;
}

function isScraperDue(scraper, runNumber) {
  const cadence = Math.max(1, scraper.cadenceRuns || 1);
  return ((runNumber - 1) % cadence) === 0;
}

function resolveThresholdProfile(retailerName, scraperName) {
  const retailerProfile = getRetailerStrategy(retailerName);
  const scraperProfile = getRetailerStrategy(scraperName);
  const hasRetailerProfile = RETAILER_STRATEGIES[retailerProfile.key] || RETAILER_MIN_DISCOUNTS.has(retailerProfile.key);

  return {
    thresholdPct: hasRetailerProfile ? retailerProfile.thresholdPct : scraperProfile.thresholdPct,
    trustScore: Math.max(scraperProfile.trustScore || 0, retailerProfile.trustScore || 0),
    focusLabel: hasRetailerProfile ? retailerProfile.focusLabel : scraperProfile.focusLabel,
  };
}

function computeDealQualityScore({
  scraper,
  retailer,
  price,
  normalPrice,
  discountPct,
  thresholdPct,
  dataPoints,
  historyValidated,
}) {
  const profile = resolveThresholdProfile(retailer, scraper.name);
  const savings = normalPrice && price ? Math.max(0, normalPrice - price) : 0;
  const discountScore = clamp(discountPct * 0.42, 0, 42);
  const thresholdHeadroomScore = clamp((discountPct - thresholdPct) * 1.5, 0, 15);
  const savingsScore = clamp(Math.log10(savings + 1) * 8, 0, 14);
  const trustScore = clamp(profile.trustScore || 0, 0, 18);
  const historyScore = clamp((dataPoints || 0) * 1.4, 0, 10);
  const validationBonus = historyValidated ? 6 : (normalPrice ? 2 : 0);
  const completenessBonus = (price ? 3 : 0) + (normalPrice ? 2 : 0) + (scraper.tier === 'core' ? 4 : 0);

  return Math.round(clamp(
    discountScore +
    thresholdHeadroomScore +
    savingsScore +
    trustScore +
    historyScore +
    validationBonus +
    completenessBonus,
    0,
    100
  ));
}

function qualitySignalLabel(score) {
  if (score >= 85) return 'A-tier';
  if (score >= 72) return 'Strong';
  if (score >= 58) return 'Watch';
  return 'Experimental';
}

function buildTrackedUrl(alertId, source, fallbackUrl = '') {
  if (!alertId) return fallbackUrl || '';
  const relativePath = `/go/${alertId}?source=${encodeURIComponent(source || 'unknown')}`;
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${relativePath}` : (fallbackUrl || relativePath);
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
    cadenceRuns: scraper.cadenceRuns,
    candidateDiscountPct: scraper.candidateDiscountPct,
    thresholdPct: scraper.thresholdPct,
    focusLabel: scraper.focusLabel,
    nextEligibleRun: computeScraperNextEligibleRun(scraper),
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
  if (!isScraperDue(scraper, runCount)) {
    return {
      status: 'scheduled',
      reason: `Cadence gate: runs every ${scraper.cadenceRuns} cycle(s)`,
    };
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
      Promise.resolve().then(() => scraper.module.scrape(scraper.candidateDiscountPct, {
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
        if (skip.status === 'scheduled') {
          state.health = ['healthy', 'degraded', 'failing', 'cooldown', 'disabled'].includes(state.health)
            ? state.health
            : (state.lastFinishedAt ? 'healthy' : 'idle');
        } else {
          state.health = deriveHealth(scraper, state);
        }
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
          details: {
            health: state.health,
            reason: skip.reason,
            cadenceRuns: scraper.cadenceRuns,
            nextEligibleRun: computeScraperNextEligibleRun(scraper),
          },
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
            const sourceLabel = deal.source || scraper.name;
            const { thresholdPct, trustScore, focusLabel } = resolveThresholdProfile(retailer, scraper.name);

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
              source: sourceLabel,
              thresholdPct,
              focusLabel,
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
            let historyValidated = false;

            if (avgPrice && dataPoints >= 3) {
              const historyDiscount = ((avgPrice - price) / avgPrice) * 100;
              if (historyDiscount >= thresholdPct) {
                confirmedDiscount = historyDiscount;
                confirmedNormal = avgPrice;
                historyValidated = true;
              } else if (discountPct < thresholdPct) {
                continue;
              }
            }

            if (confirmedDiscount < thresholdPct) continue;

            const qualityScore = computeDealQualityScore({
              scraper,
              retailer,
              price,
              normalPrice: confirmedNormal || normalPrice,
              discountPct: confirmedDiscount,
              thresholdPct,
              dataPoints,
              historyValidated,
            });
            const signalLabel = qualitySignalLabel(qualityScore);

            if (qualityScore < MIN_ALERT_SCORE) continue;

            const alertId = db.recordAlert({
              productDbId,
              glitchPrice: price,
              normalPrice: confirmedNormal || normalPrice,
              discountPct: confirmedDiscount,
              retailer,
              qualityScore,
              thresholdPct,
              signalLabel,
              sourceLabel,
            });

            confirmedDeals.push({
              ...normalizedDeal,
              alertId,
              discountPct: confirmedDiscount,
              normalPrice: confirmedNormal || normalPrice,
              dataPoints,
              qualityScore,
              signalLabel,
              sourceLabel,
              trustScore,
              trackedUrls: {
                discord: buildTrackedUrl(alertId, 'discord', url),
                email: buildTrackedUrl(alertId, 'email', url),
                dashboard: buildTrackedUrl(alertId, 'dashboard', url),
              },
            });
          } catch (err) {
            console.error('[' + scraper.name + '] Error processing deal:', err.message);
          }
        }

        confirmedDeals.sort((a, b) => {
          const scoreDiff = (b.qualityScore || 0) - (a.qualityScore || 0);
          if (scoreDiff !== 0) return scoreDiff;
          return (b.discountPct || 0) - (a.discountPct || 0);
        });

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
        console.log('[' + scraper.name + '] ✅ ' + safeDeals.length + ' raw → ' + confirmedDeals.length + ' confirmed glitches (threshold ' + scraper.thresholdPct + '% / cadence ' + scraper.cadenceRuns + 'x)');
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
      allNewDeals.sort((a, b) => {
        const scoreDiff = (b.qualityScore || 0) - (a.qualityScore || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const discountDiff = (b.discountPct || 0) - (a.discountPct || 0);
        if (discountDiff !== 0) return discountDiff;
        return (b.normalPrice || 0) - (a.normalPrice || 0);
      });

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
    minAlertScore: MIN_ALERT_SCORE,
    intervalMins: SCRAPE_INTERVAL_MINS,
    scraperTimeoutMs: SCRAPER_TIMEOUT_MS,
    trackingBaseUrl: PUBLIC_BASE_URL,
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

app.get('/api/performance', (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 30);
  const limit = Math.min(parseInt(req.query.limit || '12', 10), 25);
  try {
    res.json(db.getRetailerPerformance({ days, limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/go/:alertId', (req, res) => {
  const alertId = parseInt(req.params.alertId, 10);
  if (!Number.isFinite(alertId) || alertId <= 0) {
    return res.status(400).send('Invalid alert');
  }

  const destination = db.getAlertDestination(alertId);
  if (!destination || !destination.url) {
    return res.status(404).send('Alert destination not found');
  }

  try {
    db.recordClick({
      alertId,
      source: String(req.query.source || 'unknown').slice(0, 50),
      referrer: req.get('referer') || null,
      userAgent: req.get('user-agent') || null,
    });
  } catch (err) {
    console.error('[Tracking] Failed to record click for alert #' + alertId + ':', err.message);
  }

  return res.redirect(destination.url);
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
  console.log('  Min Score  → ' + MIN_ALERT_SCORE);
  console.log('  Timeout    → ' + Math.round(SCRAPER_TIMEOUT_MS / 1000) + 's per scraper');
  console.log('  Tracking   → ' + (PUBLIC_BASE_URL || '/go/:alertId (dashboard only)'));
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
