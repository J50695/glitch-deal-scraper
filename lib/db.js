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
  CREATE INDEX IF NOT EXISTS idx_scraper_runs_name_time ON scraper_runs(scraper_name, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scraper_runs_time      ON scraper_runs(created_at DESC);
`);

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
    INSERT INTO alerts (product_id, glitch_price, normal_price, discount_pct, retailer)
    VALUES (@productId, @glitchPrice, @normalPrice, @discountPct, @retailer)
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
    SELECT a.*, p.name, p.url, p.image_url
    FROM alerts a
    JOIN products p ON p.id = a.product_id
    ORDER BY a.alerted_at DESC
    LIMIT 100
  `),

  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products)                      AS total_products,
      (SELECT COUNT(*) FROM prices)                        AS total_price_points,
      (SELECT COUNT(*) FROM alerts)                        AS total_alerts,
      (SELECT COUNT(*) FROM alerts
       WHERE alerted_at >= datetime('now', '-24 hours'))   AS alerts_24h
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
 * Record that we fired an alert for htis product.
 */
function recordAlert({ productDbId, glitchPrice, normalPrice, discountPct, retailer }) {
  stmts.insertAlert.run({
    productId:   productDbId,
    glitchPrice,
    normalPrice,
    discountPct,
    retailer,
  });
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

/**
 * Prune price data older than 90 days (call periodically).
 */
function pruneOldData() {
  const priceResult = stmts.pruneOldPrices.run();
  const scraperResult = stmts.pruneOldScraperRuns.run();
  console.log(`[DB] Pruned ${priceResult.changes} old price records and ${scraperResult.changes} scraper run records`);
}

module.exports = {
  savePrice,
  hasRecentAlert,
  recordAlert,
  recordScraperRun,
  getRecentAlerts,
  getRecentScraperRuns,
  getStats,
  pruneOldData,
};
