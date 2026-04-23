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
    label: 'SSENSE — Men\'s Sale (Biggest Discount)',
  },
  {
    url:   'https://www.ssense.com/en-us/women/sale?sort=discount',
    label: 'SSENSE — Women\'s Sale (Biggest Discount)',
  },
  {
    url:   'https://www.ssense.com/en-us/men/shoes?sale=true&sort=discount',
    label: 'SSENSE — Men\'s Shoes Sale',
  },
  {
    url:   'https://www.ssense.com/en-us/women/shoes?sale=true&sort=discount',
    label: 'SSENSE — Women\'s Shoes Sale',
  },
  {
    url:   'https://www.ssense.com/en-us/men/clothing?sale=true&sort=discount',
    label: 'SSENSE — Men\'s Clothing Sale',
  },
];

async function scrape(minDiscountPct) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  console.log('[SSENSE] Starting designer sale scrape...');
  var deals = [];

  for (var i = 0; i < SSENSE_TARGETS.length; i++) {
    var target = SSENSE_TARGETS[i];
    var page = null;
    try {
      page = await newPage();
      await goto(page, target.url);

      await page.waitForSelector('figure, [class*="ProductCard"], [class*="product-tile"]', {
        timeout: 25000,
      }).catch(function() {});
      await sleep(3000);

      await page.evaluate(function() {
        var btns = document.querySelectorAll('button');
        btns.forEach(function(b) {
          if (b.textContent.includes('Accept') || b.textContent.includes('Close') || b.textContent.includes('OK')) {
            b.click();
          }
        });
      }).catch(function() {});
      await sleep(1000);

      for (var s = 0; s < 5; s++) {
        await page.evaluate(function() { window.scrollBy(0, window.innerHeight * 2); });
        await sleep(1200);
      }

      var products = await page.$$eval(
        'figure, [class*="ProductCard"], [class*="product-tile"], li[class*="ProductCard"]',
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

      console.log('[SSENSE] ' + target.label + ': found ' + products.length + ' items');

      for (var j = 0; j < products.length; j++) {
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

    await sleep(4000);
  }

  console.log('[SSENSE] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
