// ============================================================
//  lib/db.js â Price History Database
//  Uses SQLite (via better-sqlite3) to track product prices
//  over time and detect when something drops abnormally low.
// ============================================================

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

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

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);
  CREATE INDEX IF NOT EXISTS idx_prices_time    ON prices(scraped_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_product ON alerts(product_id, alerted_at);
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

  pruneOldPrices: db.prepare(`
    DELETE FROM prices WHERE scraped_at < datetime('now', '-90 days')
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
 * Get recent alerts for the dashboard.
 */
function getRecentAlerts() {
  return stmts.getRecentAlerts.all();
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
  const result = stmts.pruneOldPrices.run();
  console.log(`[DB] Pruned ${result.changes} old price records`);
}

module.exports = {
  savePrice,
  hasRecentAlert,
  recordAlert,
  getRecentAlerts,
  getStats,
  pruneOldData,
};
