// ============================================================
//  scrapers/dell.js — Dell Outlet & Clearance Price Detector
//
//  Dell's Outlet store sells refurbished and clearance laptops,
//  desktops, and monitors at 40-80% off. Price errors on high-end
//  XPS, Alienware, and Precision machines happen regularly.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const DELL_TARGETS = [
  { url: 'https://www.dell.com/en-us/shop/dell-refurbished-products/ar/4613?appliedRefinements=104&o=pd',          label: 'Dell Outlet — Laptops'       },
  { url: 'https://www.dell.com/en-us/shop/dell-refurbished-products/ar/4613?appliedRefinements=507',               label: 'Dell Outlet — Desktops'      },
  { url: 'https://www.dell.com/en-us/shop/dell-refurbished-products/ar/4613?appliedRefinements=14201',             label: 'Dell Outlet — Monitors'      },
  { url: 'https://www.dell.com/en-us/shop/laptop/xps-laptops/spd/xps-laptop?appliedRefinements=clearance',        label: 'Dell XPS Clearance'          },
  { url: 'https://www.dell.com/en-us/shop/cty/pdp/spd/alienware-laptops?appliedRefinements=clearance',            label: 'Dell Alienware Clearance'    },
];

async function scrape(minDiscountPct) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  console.log('[Dell] Starting scrape...');
  var deals = [];

  for (var i = 0; i < DELL_TARGETS.length; i++) {
    var target = DELL_TARGETS[i];
    var page = null;
    try {
      page = await newPage();
      await goto(page, target.url);
      await page.waitForSelector('[data-testid="product-stack-module"], .ps-product-card, .dell-card', { timeout: 20000 }).catch(function() {});
      await sleep(3000);

      var products = await page.$$eval(
        '[data-testid="product-stack-module"], .ps-product-card, .product-card, [class*="ProductCard"]',
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

      console.log('[Dell] ' + target.label + ': ' + products.length + ' items');

      for (var j = 0; j < products.length; j++) {
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
    await sleep(3000);
  }

  console.log('[Dell] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
