var playwright = require('playwright');

var URLS = [
  'https://www.nordstromrack.com/shop/Clearance',
  'https://www.nordstromrack.com/shop/Women/Shoes/Clearance',
  'https://www.nordstromrack.com/shop/Men/Shoes/Clearance',
  'https://www.nordstromrack.com/shop/Women/Clothing/Clearance',
  'https://www.nordstromrack.com/shop/Men/Clothing/Clearance',
  'https://www.nordstromrack.com/shop/Accessories/Clearance'
];

async function scrape(minDiscountPct) {
  var deals = [];
  var browser = null;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    var page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });
    for (var i = 0; i < URLS.length; i++) {
      try {
        await page.goto(URLS[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        // scroll to load more
        await page.evaluate(function() { window.scrollBy(0, 1500); });
        await page.waitForTimeout(1500);
        var items = await page.evaluate(function() {
          var results = [];
          var cards = document.querySelectorAll('[data-testid="product-card"], [class*="ProductCard"], article');
          cards.forEach(function(card) {
            var titleEl = card.querySelector('[data-testid="product-title"], [class*="title"], h3, h4');
            var priceEl = card.querySelector('[data-testid="current-price"], [class*="currentPrice"], [class*="salePrice"]');
            var origEl = card.querySelector('[data-testid="original-price"], [class*="originalPrice"], del, s');
            var linkEl = card.querySelector('a');
            if (!titleEl || !priceEl) return;
            var price = parseFloat((priceEl.innerText || '').replace(/[^0-9.]/g, ''));
            var orig = origEl ? parseFloat((origEl.innerText || '').replace(/[^0-9.]/g, '')) : 0;
            if (!price || price <= 0) return;
            results.push({ name: (titleEl.innerText || '').trim().substring(0, 80), price: price, orig: orig, url: linkEl ? linkEl.href : '' });
          });
          return results.slice(0, 40);
        });
        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          if (!item.orig || item.orig <= item.price) continue;
          var disc = Math.round(((item.orig - item.price) / item.orig) * 100);
          if (disc >= minDiscountPct) {
            deals.push({ name: item.name, price: item.price, originalPrice: item.orig, discount: disc, url: item.url, storeName: 'Nordstrom Rack' });
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('[NordstromRack] error:', e.message);
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
  return deals;
}

module.exports = { scrape };
