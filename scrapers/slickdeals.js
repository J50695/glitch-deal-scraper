var playwright = require('playwright');
var pricechecker = require('../lib/pricechecker');

// Slickdeals: community-sourced deals, many regional/store-specific, not just national sales
// Front page = most upvoted deals. Also scrape trending + new deals.
var PAGES = [
  'https://slickdeals.net/deals/electronics/',
  'https://slickdeals.net/deals/computers/',
  'https://slickdeals.net/deals/gaming/',
  'https://slickdeals.net/deals/clothing-accessories/',
  'https://slickdeals.net/deals/shoes/',
  'https://slickdeals.net/deals/toys-games/'
];

async function scrape(minDiscountPct) {
  var deals = [];
  var browser = null;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    var page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });

    for (var i = 0; i < PAGES.length; i++) {
      try {
        await page.goto(PAGES[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2500);

        var items = await page.evaluate(function() {
          var results = [];
          var cards = document.querySelectorAll('[data-type="deal"], .dealCard, [class*="dealCard"], .deal-item');
          cards.forEach(function(card) {
            var titleEl = card.querySelector('[class*="title"], [class*="dealTitle"], h3, h4, a');
            var priceEl = card.querySelector('[class*="price"], [class*="salePrice"]');
            var origEl = card.querySelector('[class*="originalPrice"], [class*="wasPrice"], del, s');
            var storeEl = card.querySelector('[class*="store"], [class*="merchant"]');
            var linkEl = card.querySelector('a[href*="slickdeals"], a[href*="/f/"], a');
            if (!titleEl) return;
            var title = (titleEl.innerText || '').trim().substring(0, 100);
            if (!title || title.length < 5) return;
            var price = priceEl ? parseFloat((priceEl.innerText || '').replace(/[^0-9.]/g, '')) : 0;
            var orig = origEl ? parseFloat((origEl.innerText || '').replace(/[^0-9.]/g, '')) : 0;
            var store = storeEl ? (storeEl.innerText || '').trim() : 'Unknown';
            var url = linkEl ? linkEl.href : '';
            if (!url || !price) return;
            results.push({ title: title, price: price, orig: orig, store: store, url: url });
          });
          return results.slice(0, 20);
        });

        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          if (!item.price || item.price <= 0) continue;

          var disc = 0;
          if (item.orig && item.orig > item.price) {
            disc = Math.round(((item.orig - item.price) / item.orig) * 100);
          }

          // Check eBay resale value to confirm it is a real flip opportunity
          var flip = null;
          if (item.price >= 15) {
            try {
              flip = await pricechecker.checkFlipValue(item.title, item.price);
            } catch(e) {}
          }

          var passesDiscount = disc >= minDiscountPct;
          var passesFlip = flip && flip.worth && flip.profit >= 20;

          if (passesDiscount || passesFlip) {
            var name = item.title;
            var source = item.store;
            if (flip && flip.worth) {
              name = item.title + ' [Flip +$' + flip.profit + ']';
              source = item.store + ' -> eBay ~$' + flip.resalePrice;
            }
            deals.push({
              name: name,
              price: item.price,
              originalPrice: item.orig || null,
              discount: disc,
              url: item.url,
              source: source,
              storeName: 'Slickdeals'
            });
          }
        }
      } catch(e) {}
    }
  } catch(e) {
    console.error('[Slickdeals] error:', e.message);
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
  return deals;
}

module.exports = { scrape };
