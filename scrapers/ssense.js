// ============================================================
//  scrapers/ssense.js — SSENSE Designer Price Glitch Detector
//
//  SSENSE is a high-end fashion retailer famous for brutal
//  markdowns — their sale section frequently hits 70-80% off
//  on top designer brands (Balenciaga, Off-White, Stone Island,
//  Bottega Veneta, etc.)
//
//  We scan their sale pages sorted by biggest discount first
//  and flag anything that hits our glitch threshold.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const SSENSE_TARGETS = [
  {
    url:   'https://www.ssense.com/en-us/men/sale?sort=discount',
    label: 'SSENSE Mens Sale',
  },
  {
    url:   'https://www.ssense.com/en-us/women/sale?sort=discount',
    label: 'SSENSE Womens Sale',
  },
  {
    url:   'https://www.ssense.com/en-us/men/shoes?sale=true&sort=discount',
    label: 'SSENSE Mens Shoes Sale',
  },
];

const SSENSE_CARD_SELECTOR = 'figure, [class*="ProductCard"], [class*="product-tile"], li[class*="ProductCard"]';
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
  console.log('[SSENSE] Starting designer sale scrape...');
  var deals = [];
  var emptyTargets = 0;
  var blockedTargets = 0;

  for (var i = 0; i < SSENSE_TARGETS.length; i++) {
    if (isAborted()) {
      console.warn('[SSENSE] Aborted before starting ' + SSENSE_TARGETS[i].label);
      break;
    }

    var target = SSENSE_TARGETS[i];
    var page = null;
    try {
      page = await newPage();
      await goto(page, target.url, { timeout: 15000 });

      await page.waitForSelector(SSENSE_CARD_SELECTOR, {
        timeout: 8000,
      }).catch(function() {});
      await sleep(1500);

      await page.evaluate(function() {
        var btns = document.querySelectorAll('button');
        btns.forEach(function(b) {
          if (b.textContent.includes('Accept') || b.textContent.includes('Close') || b.textContent.includes('OK')) {
            b.click();
          }
        });
      }).catch(function() {});
      await sleep(1000);

      for (var s = 0; s < 2; s++) {
        if (isAborted()) break;
        await page.evaluate(function() { window.scrollBy(0, window.innerHeight * 2); });
        await sleep(1000);
      }

      var snapshot = await readPageSnapshot(page);

      var products = await page.$$eval(
        SSENSE_CARD_SELECTOR,
        function(cards) {
          return cards.slice(0, 60).map(function(card) {
            var designerEl = card.querySelector('[class*="designer"], [class*="brand"]');
            var designer = designerEl ? designerEl.textContent.trim() : '';

            var nameEl = card.querySelector('[class*="name"], [class*="title"]');
            var name = nameEl ? nameEl.textContent.trim() : '';
            var fullName = designer ? (designer + ' — ' + name) : name;

            var linkEl = card.querySelector('a[href*="/p/"], a[href*="/product/"], a');
            var href = linkEl ? linkEl.href : null;

            var saleEl = card.querySelector('[class*="finalPrice"], [class*="sale"], [class*="discount-price"]');
            var saleStr = saleEl ? saleEl.textContent.trim() : null;

            var origEl = card.querySelector('[class*="fullPrice"], [class*="original"], del, s');
            var origStr = origEl ? origEl.textContent.trim() : null;

            var discEl = card.querySelector('[class*="discount"], [class*="off"], [class*="badge"]');
            var discStr = discEl ? discEl.textContent.trim() : null;

            var priceSpans = Array.from(card.querySelectorAll('span, p'))
              .map(function(el) { return el.textContent.trim(); })
              .filter(function(t) { return /\$\d+/.test(t); });

            var imgEl = card.querySelector('img[src*="ssense"], img[src*="cdn"], picture img, img');
            var imgSrc = imgEl ? (imgEl.src || imgEl.dataset.src) : null;

            return {
              name: fullName,
              href: href,
              saleStr: saleStr || priceSpans[0] || null,
              origStr: origStr || priceSpans[1] || null,
              discStr: discStr,
              imgSrc: imgSrc,
            };
          });
        }
      );

      var blocked = products.length === 0 && looksBlocked(snapshot);
      console.log('[SSENSE] ' + target.label + ': found ' + products.length + ' items' + (blocked ? ' (blocked)' : ''));

      if (blocked) {
        blockedTargets += 1;
        emptyTargets += 1;
        if (blockedTargets >= 2) {
          console.warn('[SSENSE] Repeated blocked pages, stopping early.');
          break;
        }
        continue;
      }

      if (products.length === 0) {
        emptyTargets += 1;
        if (emptyTargets >= 2) {
          console.warn('[SSENSE] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

      for (var j = 0; j < products.length; j++) {
        if (isAborted()) {
          console.warn('[SSENSE] Aborted during ' + target.label);
          break;
        }
        var p = products[j];
        if (!p.name || !p.href) continue;

        var url = p.href.startsWith('http') ? p.href : ('https://www.ssense.com' + p.href);
        var price = parsePrice(p.saleStr);
        var wasPrice = parsePrice(p.origStr);
        if (!price || price <= 0) continue;

        var discountPct = 0;
        var normalPrice = wasPrice;

        if (wasPrice && wasPrice > price) {
          discountPct = ((wasPrice - price) / wasPrice) * 100;
        } else if (p.discStr) {
          var match = p.discStr.match(/(\d+)/);
          if (match) discountPct = parseInt(match[1], 10);
          if (discountPct > 0 && price > 0) {
            normalPrice = price / (1 - discountPct / 100);
          }
        }

        if (discountPct >= minDiscountPct) {
          console.log('[SSENSE] DEAL: ' + p.name + ' — $' + price + ' (' + Math.round(discountPct) + '% off)');
          deals.push({
            productId:   'ssense_' + Buffer.from(url).toString('base64').slice(0, 20),
            retailer:    'SSENSE',
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
      console.error('[SSENSE] Error on ' + target.label + ': ' + err.message);
    } finally {
      if (page) {
        await page.context().close().catch(function() {});
      }
    }

    if (isAborted()) break;
    await sleep(1500);
  }

  console.log('[SSENSE] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
