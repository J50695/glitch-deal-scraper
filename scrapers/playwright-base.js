// ============================================================
//  scrapers/playwright-base.js â Shared Playwright Browser
//
//  All non-Amazon scrapers share one browser instance.
//  Stealth settings help avoid bot detection.
// ============================================================

const { chromium } = require('playwright');

let browser     = null;
let isLaunching = false;

// ââ Stealth HTTP headers ââââââââââââââââââââââââââââââââââââââ
const STEALTH_HEADERS = {
  'Accept-Language':          'en-US,en;q=0.9',
  'Accept':                   'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Encoding':          'gzip, deflate, br',
  'Upgrade-Insecure-Requests':'1',
  'Sec-Fetch-Dest':           'document',
  'Sec-Fetch-Mode':           'navigate',
  'Sec-Fetch-Site':           'none',
  'Sec-Fetch-User':           '?1',
  'Cache-Control':            'max-age=0',
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Get (or launch) the shared browser instance.
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  // Prevent multiple concurrent launches
  while (isLaunching) {
    await sleep(200);
  }
  if (browser && browser.isConnected()) return browser;

  isLaunching = true;
  try {
    console.log('[Browser] Launching Chromium...');
    browser = await chromium.launch({
      headless:   true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
    });
    console.log('[Browser] Chromium ready');
  } finally {
    isLaunching = false;
  }

  return browser;
}

/**
 * Open a new stealth browser page.
 */
async function newPage() {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent:       randomUA(),
    viewport:        { width: 1920, height: 1080 },
    extraHTTPHeaders: STEALTH_HEADERS,
    locale:          'en-US',
    timezoneId:      'America/New_York',
  });

  const page = await ctx.newPage();

  // Remove webdriver property (basic bot detection bypass)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  return page;
}

/**
 * Navigate with retry on timeout.
 */
async function goto(page, url, opts = {}) {
  const options = { waitUntil: 'domcontentloaded', timeout: 30000, ...opts };
  try {
    await page.goto(url, options);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn(`[Browser] Timeout navigating to ${url}, continuing anyway`);
    } else {
      throw err;
    }
  }
}

/**
 * Safely extract text from a selector (returns null if not found).
 */
async function safeText(page, selector) {
  try {
    return await page.textContent(selector, { timeout: 3000 });
  } catch {
    return null;
  }
}

/**
 * Safely extract text from all matching selectors.
 */
async function safeTexts(page, selector) {
  try {
    return await page.$$eval(selector, els => els.map(el => el.textContent?.trim() || ''));
  } catch {
    return [];
  }
}

/**
 * Parse a price string like "$24.99", "24.99", "$1,299.00" â number
 */
function parsePrice(str) {
  if (!str) return null;
  const clean = str.replace(/[^0-9.]/g, '');
  const n = parseFloat(clean);
  return isNaN(n) || n <= 0 || n > 99999 ? null : n;
}

/**
 * Close the browser (call on shutdown).
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { newPage, goto, safeText, safeTexts, parsePrice, closeBrowser, sleep };
