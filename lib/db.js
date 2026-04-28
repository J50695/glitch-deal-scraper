// ============================================================
//  lib/db.js â Price History Database
//  Uses SQLite (via better-sqlite3) to track product prices
//  over time and detect when something drops abnormally low.
// ============================================================

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'prices.db');
const db      = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// ââ Schema ââââââââââââââââââââââââââââââââââââââââââââââââââââ

db.exec(`
  -- Products we are monitoring
  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    retailer     TEXT NOT NULL,
    product_id   TEXT NOT NULL,   -- retailer-specific ID or URL hash
    name         TEXT NOT NULL,
    url          TEXT NOT NULL,
    image_url    TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(retailer, product_id)
  );

  -- Price snapshots
  CREATE TABLE IF NOT EXISTS prices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    price       REAL NOT NULL,
    scraped_at  TEXT DEFAULT (datetime('now'))
  );

  -- Glitch alerts we've fired (prevents duplicate alerts)
  CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    glitch_price    REAL NOT NULL,
    normal_price    REAL NOT NULL,
    discount_pct    REAL NOT NULL,
    retailer        TEXT NOT NULL,
    alerted_at      TEXT DEFAULT (datetime('now'))
  );

  -- Click tracking for yield measurement and conversion visibility
  CREATE TABLE IF NOT EXISTS click_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id        INTEGER NOT NULL REFERENCES alerts(id),
    source          TEXT,
    referrer        TEXT,
    user_agent      TEXT,
    clicked_at      TEXT DEFAULT (datetime('now'))
  );

  -- Scraper health history for watchdogs and dashboard visibility
  CREATE TABLE IF NOT EXISTS scraper_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_number      INTEGER NOT NULL,
    scraper_name    TEXT NOT NULL,
    tier            TEXT NOT NULL,
    status          TEXT NOT NULL,
    found           INTEGER NOT NULL DEFAULT 0,
    alerted         INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    details_json    TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);
  CREATE INDEX IF NOT EXISTS idx_prices_time    ON prices(scraped_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_product ON alerts(product_id, alerted_at);
  CREATE INDEX IF NOT EXISTS idx_click_events_alert_time ON click_events(alert_id, clicked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_click_events_time       ON click_events(clicked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scraper_runs_name_time ON scraper_runs(scraper_name, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scraper_runs_time      ON scraper_runs(created_at DESC);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('alerts', 'quality_score', 'REAL');
ensureColumn('alerts', 'threshold_pct', 'REAL');
ensureColumn('alerts', 'signal_label', 'TEXT');
ensureColumn('alerts', 'source_label', 'TEXT');

// ââ Prepared Statements âââââââââââââââââââââââââââââââââââââââ

const stmts = {
  upsertProduct: db.prepare(`
    INSERT INTO products (retailer, product_id, name, url, image_url)
    VALUES (@retailer, @productId, @name, @url, @imageUrl)
    ON CONFLICT(retailer, product_id) DO UPDATE SET
      name      = excluded.name,
      url       = excluded.url,
      image_url = excluded.image_url
    RETURNING id
  `),

  insertPrice: db.prepare(`
    INSERT INTO prices (product_id, price) VALUES (?, ?)
  `),

  getAvgPrice: db.prepare(`
    SELECT AVG(price) as avg_price, COUNT(*) as data_points
    FROM prices
    WHERE product_id = ?
      AND scraped_at >= datetime('now', '-30 days')
      AND price > 0
  `),

  getRecentPrices: db.prepare(`
    SELECT price, scraped_at
    FROM prices
    WHERE product_id = ?
    ORDER BY scraped_at DESC
    LIMIT 30
  `),

  checkRecentAlert: db.prepare(`
    SELECT id FROM alerts
    WHERE product_id = ?
      AND alerted_at >= datetime('now', '-4 hours')
    LIMIT 1
  `),

  insertAlert: db.prepare(`
    INSERT INTO alerts (
      product_id,
      glitch_price,
      normal_price,
      discount_pct,
      retailer,
      quality_score,
      threshold_pct,
      signal_label,
      source_label
    )
    VALUES (
      @productId,
      @glitchPrice,
      @normalPrice,
      @discountPct,
      @retailer,
      @qualityScore,
      @thresholdPct,
      @signalLabel,
      @sourceLabel
    )
  `),

  insertClickEvent: db.prepare(`
    INSERT INTO click_events (alert_id, source, referrer, user_agent)
    VALUES (@alertId, @source, @referrer, @userAgent)
  `),

  insertScraperRun: db.prepare(`
    INSERT INTO scraper_runs (
      run_number,
      scraper_name,
      tier,
      status,
      found,
      alerted,
      duration_ms,
      error_message,
      details_json
    )
    VALUES (
      @runNumber,
      @scraperName,
      @tier,
      @status,
      @found,
      @alerted,
      @durationMs,
      @errorMessage,
      @detailsJson
    )
  `),

  getRecentAlerts: db.prepare(`
    SELECT
      a.*,
      p.name,
      p.url,
      p.image_url,
      COALESCE(clicks.click_count, 0) AS click_count
    FROM alerts a
    JOIN products p ON p.id = a.product_id
    LEFT JOIN (
      SELECT alert_id, COUNT(*) AS click_count
      FROM click_events
      GROUP BY alert_id
    ) clicks ON clicks.alert_id = a.id
    ORDER BY a.alerted_at DESC, a.quality_score DESC, a.id DESC
    LIMIT 100
  `),

  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products)                      AS total_products,
      (SELECT COUNT(*) FROM prices)                        AS total_price_points,
      (SELECT COUNT(*) FROM alerts)                        AS total_alerts,
      (SELECT COUNT(*) FROM alerts
       WHERE alerted_at >= datetime('now', '-24 hours'))   AS alerts_24h,
      (SELECT COUNT(*) FROM click_events)                  AS total_clicks,
      (SELECT COUNT(*) FROM click_events
       WHERE clicked_at >= datetime('now', '-24 hours'))   AS clicks_24h,
      (SELECT ROUND(AVG(quality_score), 1)
       FROM alerts
       WHERE alerted_at >= datetime('now', '-7 days')
         AND quality_score IS NOT NULL)                    AS avg_alert_score_7d
  `),

  getRetailerPerformance: db.prepare(`
    SELECT
      a.retailer,
      COUNT(*) AS alerts_count,
      COALESCE(SUM(clicks.click_count), 0) AS total_clicks,
      ROUND(AVG(a.discount_pct), 1) AS avg_discount_pct,
      ROUND(AVG(COALESCE(a.quality_score, 0)), 1) AS avg_quality_score,
      ROUND(AVG(a.normal_price - a.glitch_price), 2) AS avg_savings,
      MAX(a.alerted_at) AS last_alerted_at
    FROM alerts a
    LEFT JOIN (
      SELECT alert_id, COUNT(*) AS click_count
      FROM click_events
      GROUP BY alert_id
    ) clicks ON clicks.alert_id = a.id
    WHERE a.alerted_at >= datetime('now', ?)
    GROUP BY a.retailer
    ORDER BY total_clicks DESC, alerts_count DESC, avg_quality_score DESC
    LIMIT ?
  `),

  getAlertDestination: db.prepare(`
    SELECT
      a.id,
      a.retailer,
      p.url
    FROM alerts a
    JOIN products p ON p.id = a.product_id
    WHERE a.id = ?
    LIMIT 1
  `),

  getRecentScraperRuns: db.prepare(`
    SELECT
      run_number,
      scraper_name,
      tier,
      status,
      found,
      alerted,
      duration_ms,
      error_message,
      details_json,
      created_at
    FROM scraper_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `),

  pruneOldPrices: db.prepare(`
    DELETE FROM prices WHERE scraped_at < datetime('now', '-90 days')
  `),

  pruneOldScraperRuns: db.prepare(`
    DELETE FROM scraper_runs WHERE created_at < datetime('now', '-30 days')
  `),

  pruneOldClicks: db.prepare(`
    DELETE FROM click_events WHERE clicked_at < datetime('now', '-90 days')
  `),
};

// ââ Public API ââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Save a price snapshot for a product.
 * Returns { productDbId, isNew, avgPrice, dataPoints }
 */
function savePrice({ retailer, productId, name, url, imageUrl, price }) {
  // Upsert product record
  const row = stmts.upsertProduct.get({ retailer, productId, name, url, imageUrl: imageUrl || null });
  const dbId = row ? row.id : getProductId(retailer, productId);

  // Record the price
  stmts.insertPrice.run(dbId, price);

  // Get current 30-day average
  const avg = stmts.getAvgPrice.get(dbId);

  return {
    productDbId: dbId,
    avgPrice:    avg?.avg_price   || null,
    dataPoints:  avg?.data_points || 0,
  };
}

/**
 * Get a product's DB ID (fallback if upsert doesn't return it).
 */
function getProductId(retailer, productId) {
  const row = db.prepare(
    'SELECT id FROM products WHERE retailer = ? AND product_id = ?'
  ).get(retailer, productId);
  return row?.id;
}

/**
 * Check if we've already alerted on this product in the last 4 hours.
 * Prevents spam when a glitch price persists across multiple scrape runs.
 */
function hasRecentAlert(productDbId) {
  return !!stmts.checkRecentAlert.get(productDbId);
}

/**
 * Record that we fired an alert for this product.
 */
function recordAlert({
  productDbId,
  glitchPrice,
  normalPrice,
  discountPct,
  retailer,
  qualityScore = null,
  thresholdPct = null,
  signalLabel = null,
  sourceLabel = null,
}) {
  const result = stmts.insertAlert.run({
    productId:   productDbId,
    glitchPrice,
    normalPrice,
    discountPct,
    retailer,
    qualityScore,
    thresholdPct,
    signalLabel,
    sourceLabel,
  });
  return Number(result.lastInsertRowid);
}

function recordClick({ alertId, source = 'unknown', referrer = null, userAgent = null }) {
  stmts.insertClickEvent.run({
    alertId,
    source,
    referrer,
    userAgent,
  });
}

function getAlertDestination(alertId) {
  return stmts.getAlertDestination.get(alertId) || null;
}

/**
 * Persist a scraper execution result for health tracking and UI history.
 */
function recordScraperRun({
  runNumber,
  scraperName,
  tier,
  status,
  found = 0,
  alerted = 0,
  durationMs = 0,
  errorMessage = null,
  details = null,
}) {
  stmts.insertScraperRun.run({
    runNumber,
    scraperName,
    tier: tier || 'core',
    status,
    found,
    alerted,
    durationMs,
    errorMessage,
    detailsJson: details ? JSON.stringify(details) : null,
  });
}

/**
 * Get recent alerts for the dashboard.
 */
function getRecentAlerts() {
  return stmts.getRecentAlerts.all();
}

/**
 * Get recent per-scraper runs for dashboard history and debugging.
 */
function getRecentScraperRuns(limit = 100) {
  return stmts.getRecentScraperRuns.all(limit).map((row) => ({
    run_number: row.run_number,
    scraper_name: row.scraper_name,
    tier: row.tier,
    status: row.status,
    found: row.found,
    alerted: row.alerted,
    duration_ms: row.duration_ms,
    error_message: row.error_message,
    created_at: row.created_at,
    details: row.details_json ? JSON.parse(row.details_json) : null,
  }));
}

/**
 * Get database stats.
 */
function getStats() {
  return stmts.getStats.get();
}

function getRetailerPerformance({ days = 7, limit = 12 } = {}) {
  const safeDays = Math.max(1, Math.min(Number(days) || 7, 30));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 25));
  const rows = stmts.getRetailerPerformance.all(`-${safeDays} days`, safeLimit);

  return rows.map((row) => ({
    retailer: row.retailer,
    alerts_count: row.alerts_count,
    total_clicks: row.total_clicks,
    click_yield: row.alerts_count > 0 ? Number((row.total_clicks / row.alerts_count).toFixed(2)) : 0,
    avg_discount_pct: row.avg_discount_pct || 0,
    avg_quality_score: row.avg_quality_score || 0,
    avg_savings: row.avg_savings || 0,
    last_alerted_at: row.last_alerted_at,
  }));
}

/**
 * Prune price data older than 90 days (call periodically).
 */
function pruneOldData() {
  const priceResult = stmts.pruneOldPrices.run();
  const scraperResult = stmts.pruneOldScraperRuns.run();
  const clickResult = stmts.pruneOldClicks.run();
  console.log(`[DB] Pruned ${priceResult.changes} old price records, ${scraperResult.changes} scraper run records, and ${clickResult.changes} click records`);
}

module.exports = {
  savePrice,
  hasRecentAlert,
  recordAlert,
  recordClick,
  recordScraperRun,
  getAlertDestination,
  getRecentAlerts,
  getRecentScraperRuns,
  getStats,
  getRetailerPerformance,
  pruneOldData,
};
