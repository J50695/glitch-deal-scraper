var playwright = require('playwright');

var MIN_PROFIT = 30;

var TERMS = [
  { q: 'Jordan 1 High', flip: 280, where: 'StockX', label: 'Jordan 1 High' },
  { q: 'Jordan 4 Retro', flip: 250, where: 'StockX', label: 'Jordan 4 Retro' },
  { q: 'Yeezy 350 V2', flip: 220, where: 'StockX', label: 'Yeezy 350 V2' },
  { q: 'Yeezy 700', flip: 180, where: 'StockX', label: 'Yeezy 700' },
  { q: 'New Balance 550', flip: 130, where: 'StockX', label: 'New Balance 550' },
  { q: 'New Balance 990v5', flip: 185, where: 'StockX', label: 'New Balance 990' },
  { q: 'Nike Dunk Low', flip: 120, where: 'StockX', label: 'Nike Dunk Low' },
  { q: 'Travis Scott Jordan', flip: 450, where: 'StockX', label: 'Travis Scott Jordan' },
  { q: 'Off White Nike', flip: 500, where: 'StockX', label: 'Off White Nike' },
  { q: 'Nike Sacai', flip: 300, where: 'StockX', label: 'Nike Sacai' },
  { q: 'iPhone 15 Pro', flip: 750, where: 'eBay', label: 'iPhone 15 Pro' },
  { q: 'iPhone 16', flip: 700, where: 'eBay', label: 'iPhone 16' },
  { q: 'MacBook Air M2', flip: 900, where: 'eBay', label: 'MacBook Air M2' },
  { q: 'MacBook Air M3', flip: 1000, where: 'eBay', label: 'MacBook Air M3' },
  { q: 'Samsung Galaxy S24', flip: 600, where: 'eBay', label: 'Galaxy S24' },
  { q: 'Apple Watch Ultra', flip: 650, where: 'eBay', label: 'Apple Watch Ultra' },
  { q: 'AirPods Pro 2', flip: 180, where: 'eBay', label: 'AirPods Pro 2' },
  { q: 'iPad Pro 2024', flip: 700, where: 'eBay', label: 'iPad Pro' },
  { q: 'PS5 console', flip: 380, where: 'eBay', label: 'PS5' },
  { q: 'Xbox Series X', flip: 350, where: 'eBay', label: 'Xbox Series X' },
  { q: 'Steam Deck OLED', flip: 500, where: 'eBay', label: 'Steam Deck OLED' },
  { q: 'Nintendo Switch OLED', flip: 250, where: 'eBay', label: 'Switch OLED' },
  { q: 'Supreme Box Logo hoodie', flip: 600, where: 'eBay', label: 'Supreme Box Logo' },
  { q: 'Bape hoodie', flip: 300, where: 'eBay', label: 'Bape Hoodie' },
  { q: 'Chrome Hearts ring', flip: 400, where: 'eBay', label: 'Chrome Hearts' },
  { q: 'Stone Island jacket', flip: 350, where: 'eBay', label: 'Stone Island' }
];

async function scrapeTerm(page, term) {
  var deals = [];
  try {
    var url = 'https://offerup.com/search/?q=' + encodeURIComponent(term.q) + '&condition=1&sort=1';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2500);
    var items = await page.evaluate(function() {
      var results = [];
      var cards = document.querySelectorAll('li[data-testid]');
      if (!cards.length) { cards = document.querySelectorAll('[class*="listing"]'); }
      cards.forEach(function(card) {
        var priceEl = card.querySelector('[class*="price"]');
        var linkEl = card.querySelector('a');
        if (!priceEl || !linkEl) return;
        var priceText = priceEl.innerText.replace(/[^0-9.]/g, '');
        var price = parseFloat(priceText);
        if (!price) return;
        results.push({ price: price, url: linkEl.href || '' });
      });
      return results;
    });
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!item.price || item.price <= 0) continue;
      var profit = term.flip - item.price;
      var pct = Math.round((profit / term.flip) * 100);
      if (profit >= MIN_PROFIT) {
        deals.push({
          name: term.label + ' [Flip to ' + term.where + ']',
          price: item.price,
          originalPrice: term.flip,
          discount: pct,
          url: item.url || 'https://offerup.com/search/?q=' + encodeURIComponent(term.q),
          source: term.label + ' (New) (+$' + Math.round(profit) + ' profit)',
          storeName: 'OfferUp'
        });
      }
    }
  } catch (e) {}
  return deals;
}

async function scrape(minDiscountPct) {
  var deals = [];
  var browser = null;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    var ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15' });
    var page = await ctx.newPage();
    for (var i = 0; i < TERMS.length; i++) {
      var found = await scrapeTerm(page, TERMS[i]);
      deals = deals.concat(found);
      await page.waitForTimeout(800);
    }
  } catch (e) {
    console.error('[OfferUp] error:', e.message);
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
  return deals;
}

module.exports = { scrape };
