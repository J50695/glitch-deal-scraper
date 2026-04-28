// ============================================================
//  scrapers/dell.js — Dell Outlet & Clearance Price Detector
//
//  Dell's Outlet store sells refurbished and clearance laptops,
//  desktops, and monitors at 40-80% off. Price errors on high-end
//  XPS, Alienware, and Precision machines happen regularly.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const DELL_TARGETS = [
  { url: 'https://www.dell.com/en-us/shop/dell-refurbished-products/ar/4613?appliedRefinements=104&o=pd',   label: 'Dell Outlet Laptops' },
  { url: 'https://www.dell.com/en-us/shop/dell-refurbished-products/ar/4613?appliedRefinements=507',        label: 'Dell Outlet Desktops' },
  { url: 'https://www.dell.com/en-us/shop/laptop/xps-laptops/spd/xps-laptop?appliedRefinements=clearance', label: 'Dell XPS Clearance' },
];

const DELL_CARD_SELECTOR = '[data-testid="product-stack-module"], .ps-product-card, .product-card, [class*="ProductCard"]';
const BLOCKED_PATTERNS = [
  /access denied/i,
  /verify you are human/i,
  /security check/i,
  /captcha/i,
  /forbidden/i,
];

async function readPageSnapshot(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title || '',
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
  } catch {
    return { title: '', body: '' };
  }
}

function looksBlocked(snapshot) {
  const text = `${snapshot.title} ${snapshot.body}`;
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

async function scrape(minDiscountPct, options = {}) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[Dell] Starting scrape...');
  var deals = [];
  var emptyTargets = 0;
  var blockedTargets = 0;

  for (var i = 0; i < DELL_TARGETS.length; i++) {
    if (isAborted()) {
      console.warn('[Dell] Aborted before starting ' + DELL_TARGETS[i].label);
      break;
    }

    var target = DELL_TARGETS[i];
    var page = null;
    try {
      page = await newPage();
      await goto(page, target.url, { timeout: 12000 });
      await page.waitForSelector(DELL_CARD_SELECTOR, { timeout: 7000 }).catch(function() {});
      await sleep(1500);

      var snapshot = await readPageSnapshot(page);

      var products = await page.$$eval(
        DELL_CARD_SELECTOR,
        function(cards) {
          return cards.slice(0, 40).map(function(card) {
            var nameEl = card.querySelector('h3, h2, [data-testid="product-title"], .product-title, [class*="title"]');
            var name = nameEl ? nameEl.textContent.trim() : null;

            var linkEl = card.querySelector('a[href*="/en-us/shop/"], a[href*="dell.com"], a');
            var href = linkEl ? linkEl.href : null;

            var priceEl = card.querySelector('[data-testid="primary-price"], .price-sales, [class*="price"]');
            var priceStr = priceEl ? priceEl.textContent.trim() : null;

            var wasEl = card.querySelector('[data-testid="original-price"], .price-standard, del, s, strike');
            var wasStr = wasEl ? wasEl.textContent.trim() : null;

            var saveEl = card.querySelector('[data-testid="savings"], [class*="savings"], [class*="discount"]');
            var saveStr = saveEl ? saveEl.textContent.trim() : null;

            var imgEl = card.querySelector('img');
            var imgSrc = imgEl ? imgEl.src : null;

            return { name: name, href: href, priceStr: priceStr, wasStr: wasStr, saveStr: saveStr, imgSrc: imgSrc };
          });
        }
      );

      var blocked = products.length === 0 && looksBlocked(snapshot);
      console.log('[Dell] ' + target.label + ': ' + products.length + ' items' + (blocked ? ' (blocked)' : ''));

      if (blocked) {
        blockedTargets += 1;
        emptyTargets += 1;
        if (blockedTargets >= 2) {
          console.warn('[Dell] Repeated blocked pages, stopping early.');
          break;
        }
        continue;
      }

      if (products.length === 0) {
        emptyTargets += 1;
        if (emptyTargets >= 2) {
          console.warn('[Dell] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

      for (var j = 0; j < products.length; j++) {
        if (isAborted()) {
          console.warn('[Dell] Aborted during ' + target.label);
          break;
        }
        var p = products[j];
        if (!p.name || !p.priceStr) continue;
        var url = p.href || target.url;
        var price = parsePrice(p.priceStr);
        var wasPrice = parsePrice(p.wasStr);
        if (!price || price <= 0) continue;

        var discountPct = 0;
        var normalPrice = wasPrice;

        if (wasPrice && wasPrice > price) {
          discountPct = ((wasPrice - price) / wasPrice) * 100;
        } else if (p.saveStr) {
          var m = p.saveStr.match(/(\d+)%/);
          if (m) discountPct = parseInt(m[1]);
          var saveAmt = parsePrice(p.saveStr);
          if (!discountPct && saveAmt && saveAmt > 0) {
            normalPrice = price + saveAmt;
            discountPct = (saveAmt / normalPrice) * 100;
          }
        }

        if (discountPct >= minDiscountPct) {
          console.log('[Dell] DEAL: ' + p.name + ' — $' + price + ' (' + Math.round(discountPct) + '% off)');
          deals.push({
            productId:   'dell_' + Buffer.from(url).toString('base64').slice(0, 20),
            retailer:    'Dell',
            name:        p.name,
            url:         url,
            imageUrl:    p.imgSrc || null,
            price:       price,
            normalPrice: normalPrice || null,
            discountPct: discountPct,
            source:      target.label,
          });
        }
      }

    } catch (err) {
      console.error('[Dell] Error on ' + target.label + ': ' + err.message);
    } finally {
      if (page) await page.context().close().catch(function() {});
    }
    if (isAborted()) break;
    await sleep(1500);
  }

  console.log('[Dell] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
