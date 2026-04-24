var playwright = require('playwright');

var URLS = [
  'https://www.newegg.com/promotions/NEedf/index',
  'https://www.newegg.com/tools/daily-deals',
  'https://www.newegg.com/clearance',
  'https://www.newegg.com/Laptops-Notebooks/SubCategory/ID-32/Price-100-500',
  'https://www.newegg.com/open-box'
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
        await page.waitForTimeout(2500);
        var items = await page.evaluate(function() {
          var results = [];
          var cards = document.querySelectorAll('.item-cell, [class*="item-cell"], .item-container');
          cards.forEach(function(card) {
            var titleEl = card.querySelector('.item-title, [class*="item-title"]');
            var priceEl = card.querySelector('.price-current, [class*="price-current"]');
            var origEl = card.querySelector('.price-was, [class*="price-was"], del');
            var linkEl = card.querySelector('a.item-title, a');
            if (!titleEl || !priceEl) return;
            var price = parseFloat((priceEl.innerText || '').replace(/[^0-9.]/g, ''));
            var orig = origEl ? parseFloat((origEl.innerText || '').replace(/[^0-9.]/g, '')) : 0;
            if (!price || price <= 0) return;
            results.push({ name: (titleEl.innerText || '').trim().substring(0, 80), price: price, orig: orig, url: linkEl ? linkEl.href : '' });
          });
          return results;
        });
        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          if (!item.orig || item.orig <= item.price) continue;
          var disc = Math.round(((item.orig - item.price) / item.orig) * 100);
          if (disc >= minDiscountPct) {
            deals.push({ name: item.name, price: item.price, originalPrice: item.orig, discount: disc, url: item.url, storeName: 'Newegg' });
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('[Newegg] error:', e.message);
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
  return deals;
}

module.exports = { scrape };
