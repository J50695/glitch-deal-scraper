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
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const path       = require('path');

const db         = require('./lib/db');
const notifier   = require('./lib/notifier');
const { closeBrowser } = require('./scrapers/playwright-base');

// ── Scrapers ──────────────────────────────────────────────────
function safeRequire(p) {
  try { return require(p); } catch(e) { console.error('[LOAD ERROR]', p, e.message); return { scrape: async function() { return []; } }; }
}

const scrapers = [
  // Core retail
  { name: 'Amazon',         module: safeRequire('./scrapers/amazon'),         enabled: !!process.env.KEEPA_API_KEY },
  { name: 'Best Buy',       module: safeRequire('./scrapers/bestbuy'),        enabled: true },
  { name: 'Walmart',        module: safeRequire('./scrapers/walmart'),        enabled: true },
  { name: 'Target',         module: safeRequire('./scrapers/target'),         enabled: true },
  // Sneakers & Apparel
  { name: 'Nike',           module: safeRequire('./scrapers/nike'),           enabled: true },
  { name: 'Adidas',         module: safeRequire('./scrapers/adidas'),         enabled: true },
  // Designer / Luxury
  { name: 'Farfetch',       module: safeRequire('./scrapers/farfetch'),       enabled: true },
  { name: 'SSENSE',         module: safeRequire('./scrapers/ssense'),         enabled: true },
  // Clearance / Outlet / Daily Deals
  { name: 'Woot',           module: safeRequire('./scrapers/woot'),           enabled: true },
  { name: 'Dell',           module: safeRequire('./scrapers/dell'),           enabled: true },
  // Marketplace (new items only)
  { name: 'Newegg',         module: safeRequire('./scrapers/newegg'),         enabled: true },
  { name: '6pm',            module: safeRequire('./scrapers/sixpm'),          enabled: true },
  { name: 'Nordstrom Rack', module: safeRequire('./scrapers/nordstromrack'),  enabled: true },
  { name: 'B&H Photo',      module: safeRequire('./scrapers/bhphoto'),        enabled: true },
  { name: 'Slickdeals',    module: safeRequire('./scrapers/slickdeals'),   enabled: true },
  { name: 'OfferUp',        module: safeRequire('./scrapers/offerup'),        enabled: true },
];

// ── Config ────────────────────────────────────────────────────
const MIN_DISCOUNT_PCT      = parseFloat(process.env.MIN_DISCOUNT_PCT || '40');
const SCRAPE_INTERVAL_MINS  = parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '10');
const PORT                  = parseInt(process.env.PORT || '3000');

// ── State ─────────────────────────────────────────────────────
let isRunning    = false;
let lastRun      = null;
let nextRun      = null;
let runCount     = 0;
let lastBatchNew = 0;
const runLog     = []; // last 20 run summaries

// ── Main Scraper ──────────────────────────────────────────────

async function runScraper() {
  if (isRunning) {
    console.log('[Orchestrator] Already running — skipping this cycle');
    return;
  }

  isRunning    = true;
  lastRun      = new Date().toISOString();
  runCount++;

  const runSummary = {
    run:        runCount,
    startedAt:  lastRun,
    scrapers:   {},
    totalNew:   0,
    errors:     [],
  };

  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Scrape run #' + runCount + ' — ' + new Date().toLocaleString());
  console.log('═'.repeat(60));

  const allNewDeals = [];

  for (const scraper of scrapers) {
    if (!scraper.enabled) {
      console.log('[' + scraper.name + '] ⏭  Skipped (disabled)');
      continue;
    }

    console.log('\n[' + scraper.name + '] Starting...');
    const scraperStart = Date.now();

    try {
      const rawDeals = await scraper.module.scrape(MIN_DISCOUNT_PCT);

      const confirmedDeals = [];

      for (const deal of rawDeals) {
        try {
          const { productDbId, avgPrice, dataPoints } = db.savePrice({
            retailer:   deal.retailer,
            productId:  deal.productId,
            name:       deal.name,
            url:        deal.url,
            imageUrl:   deal.imageUrl,
            price:      deal.price,
          });

          if (db.hasRecentAlert(productDbId)) continue;

          let confirmedDiscount = deal.discountPct;
          let confirmedNormal   = deal.normalPrice;

          if (avgPrice && dataPoints >= 3) {
            const historyDiscount = ((avgPrice - deal.price) / avgPrice) * 100;
            if (historyDiscount >= MIN_DISCOUNT_PCT) {
              confirmedDiscount = historyDiscount;
              confirmedNormal   = avgPrice;
            } else if (deal.discountPct < MIN_DISCOUNT_PCT) {
              continue;
            }
          }

          if (confirmedDiscount < MIN_DISCOUNT_PCT) continue;

          db.recordAlert({
            productDbId,
            glitchPrice:  deal.price,
            normalPrice:  confirmedNormal || deal.normalPrice,
            discountPct:  confirmedDiscount,
            retailer:     deal.retailer,
          });

          confirmedDeals.push({
            ...deal,
            discountPct:  confirmedDiscount,
            normalPrice:  confirmedNormal || deal.normalPrice,
            dataPoints,
          });

        } catch (err) {
          console.error('[' + scraper.name + '] Error processing deal:', err.message);
        }
      }

      runSummary.scrapers[scraper.name] = {
        found:    rawDeals.length,
        alerted:  confirmedDeals.length,
        ms:       Date.now() - scraperStart,
      };

      allNewDeals.push(...confirmedDeals);
      console.log('[' + scraper.name + '] ✅ ' + rawDeals.length + ' raw → ' + confirmedDeals.length + ' confirmed glitches');

    } catch (err) {
      const msg = '[' + scraper.name + '] ❌ Fatal error: ' + err.message;
      console.error(msg);
      runSummary.scrapers[scraper.name] = { error: err.message };
      runSummary.errors.push(msg);
    }
  }

  // ── Fire alerts ───────────────────────────────────────────
  if (allNewDeals.length > 0) {
    console.log('\n🚨 Sending ' + allNewDeals.length + ' alert(s)...');

    for (const deal of allNewDeals) {
      await notifier.sendDiscordAlert(deal);
      await new Promise(r => setTimeout(r, 400));
    }

    await notifier.sendEmailDigest(allNewDeals);
  }

  runSummary.totalNew  = allNewDeals.length;
  runSummary.endedAt   = new Date().toISOString();
  lastBatchNew         = allNewDeals.length;

  runLog.unshift(runSummary);
  if (runLog.length > 20) runLog.pop();

  if (runCount % 144 === 0) db.pruneOldData();

  isRunning = false;
  console.log('\n✅ Run #' + runCount + ' complete — ' + allNewDeals.length + ' new glitch deal(s)');
  console.log('═'.repeat(60) + '\n');
}

// ── Express Dashboard & API ───────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/alerts', (req, res) => {
  try {
    const alerts = db.getRecentAlerts();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  const dbStats = db.getStats();
  res.json({
    ...dbStats,
    isRunning,
    lastRun,
    nextRun,
    runCount,
    lastBatchNew,
    minDiscount:    MIN_DISCOUNT_PCT,
    intervalMins:   SCRAPE_INTERVAL_MINS,
    enabledScrapers: scrapers.filter(s => s.enabled).map(s => s.name),
    discordLinked:  !!process.env.DISCORD_WEBHOOK_URL,
    emailLinked:    !!process.env.EMAIL_USER,
    keepaLinked:    !!process.env.KEEPA_API_KEY,
  });
});

app.get('/api/runs', (req, res) => res.json(runLog));

app.post('/api/scrape', (req, res) => {
  if (isRunning) {
    return res.json({ success: false, message: 'Already running' });
  }
  runScraper().catch(console.error);
  res.json({ success: true, message: 'Scrape started' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// ── Start ─────────────────────────────────────────────────────

const cronExpr = '*/' + SCRAPE_INTERVAL_MINS + ' * * * *';
cron.schedule(cronExpr, () => {
  nextRun = null;
  runScraper().catch(console.error).finally(() => {
    const next = new Date(Date.now() + SCRAPE_INTERVAL_MINS * 60 * 1000);
    nextRun = next.toISOString();
  });
});

app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(60));
  console.log('  🔥 GLITCH DEAL SCRAPER v3 — ONLINE');
  console.log('═'.repeat(60));
  console.log('  Dashboard  → http://localhost:' + PORT);
  console.log('  Interval   → every ' + SCRAPE_INTERVAL_MINS + ' minutes');
  console.log('  Min Disc.  → ' + MIN_DISCOUNT_PCT + '% off');
  console.log('  Discord    → ' + (process.env.DISCORD_WEBHOOK_URL ? '✅ connected' : '❌ NOT SET'));
  console.log('  Email      → ' + (process.env.EMAIL_USER          ? '✅ connected' : '❌ not set (optional)'));
  console.log('  Keepa/Amzn → ' + (process.env.KEEPA_API_KEY       ? '✅ connected' : '⚠️  not set (Amazon disabled)'));
  console.log('  Scrapers   → ' + scrapers.filter(s => s.enabled).map(s => s.name).join(', '));
  console.log('═'.repeat(60) + '\n');

  setTimeout(() => {
    nextRun = null;
    runScraper().catch(console.error).finally(() => {
      const next = new Date(Date.now() + SCRAPE_INTERVAL_MINS * 60 * 1000);
      nextRun = next.toISOString();
    });
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
