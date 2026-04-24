var playwright = require('playwright');

// Cache to avoid hammering eBay for the same product
var cache = {};
var CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Scrape eBay SOLD listings to get real market resale price
async function getEbayResalePrice(productName) {
  var key = productName.toLowerCase().trim();
  var now = Date.now();
  if (cache[key] && (now - cache[key].ts) < CACHE_TTL) {
    return cache[key].price;
  }

  var browser = null;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    var page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });

    // Search eBay completed/sold listings - these are REAL prices people paid
    var query = encodeURIComponent(productName);
    var url = 'https://www.ebay.com/sch/i.html?_nkw=' + query + '&LH_Sold=1&LH_Complete=1&_sop=13';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    var prices = await page.evaluate(function() {
      var results = [];
      var items = document.querySelectorAll('.s-item__price, [class*="s-item__price"]');
      items.forEach(function(el) {
        var text = el.innerText || '';
        // Handle price ranges like $100.00 to $150.00 - take the lower
        var matches = text.match(/\$([0-9,]+\.?[0-9]*)/g);
        if (matches && matches.length > 0) {
          var price = parseFloat(matches[0].replace(/[$,]/g, ''));
          if (price > 5 && price < 50000) results.push(price);
        }
      });
      return results;
    });

    if (!prices || prices.length < 3) {
      cache[key] = { price: null, ts: now };
      return null;
    }

    // Sort and take median of middle 60% to filter outliers
    prices.sort(function(a, b) { return a - b; });
    var trim = Math.floor(prices.length * 0.2);
    var trimmed = prices.slice(trim, prices.length - trim);
    var median = trimmed[Math.floor(trimmed.length / 2)];

    cache[key] = { price: median, ts: now };
    return median;

  } catch (e) {
    console.error('[PriceChecker] eBay lookup failed for', productName, ':', e.message);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
}

// Check if a deal is worth flipping: returns { worth: bool, resalePrice, profit, profitPct }
async function checkFlipValue(dealName, dealPrice) {
  var resalePrice = await getEbayResalePrice(dealName);
  if (!resalePrice) return { worth: false, resalePrice: null, profit: 0, profitPct: 0 };

  // Account for eBay fees (~13%) + shipping (~$10)
  var netResale = resalePrice * 0.87 - 10;
  var profit = netResale - dealPrice;
  var profitPct = Math.round((profit / dealPrice) * 100);

  return {
    worth: profit >= 20,
    resalePrice: Math.round(resalePrice),
    netResale: Math.round(netResale),
    profit: Math.round(profit),
    profitPct: profitPct
  };
}

module.exports = { getEbayResalePrice, checkFlipValue };
