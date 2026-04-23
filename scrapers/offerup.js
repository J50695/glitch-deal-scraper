// ============================================================
//  scrapers/offerup.js — OfferUp NEW Items Price Detector
//
//  OfferUp is a local marketplace where sellers often misprice
//  brand-new items way below retail. We search key categories
//  filtered to NEW condition only, sorted by lowest price, and
//  flag anything that's suspiciously cheap vs. known market value.
//
//  condition=1 → New
//  sort=1      → Lowest price first
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

// Search terms + their typical retail reference prices for glitch detection.
// If an item is found below (refPrice * threshold), it gets flagged.
const OFFERUP_SEARCHES = [
  // Electronics
  { q: 'iphone 15',          refPrice: 799,   label: 'OfferUp — iPhone 15 (New)'         },
  { q: 'iphone 16',          refPrice: 899,   label: 'OfferUp — iPhone 16 (New)'         },
  { q: 'macbook',            refPrice: 999,   label: 'OfferUp — MacBook (New)'           },
  { q: 'laptop',             refPrice: 600,   label: 'OfferUp — Laptop (New)'            },
  { q: 'playstation 5',      refPrice: 499,   label: 'OfferUp — PS5 (New)'              },
  { q: 'xbox series x',      refPrice: 499,   label: 'OfferUp — Xbox Series X (New)'    },
  { q: 'nintendo switch',    refPrice: 299,   label: 'OfferUp — Nintendo Switch (New)'  },
  { q: 'ipad',               refPrice: 449,   label: 'OfferUp — iPad (New)'             },
  { q: 'airpods pro',        refPrice: 249,   label: 'OfferUp — AirPods Pro (New)'      },
  { q: 'samsung tv',         refPrice: 500,   label: 'OfferUp — Samsung TV (New)'       },
  // Sneakers
  { q: 'jordan 1',           refPrice: 180,   label: 'OfferUp — Jordan 1 (New)'         },
  { q: 'yeezy',              refPrice: 220,   label: 'OfferUp — Yeezy (New)'            },
  { q: 'travis scott nike',  refPrice: 300,   label: 'OfferUp — Travis Scott (New)'     },
  { q: 'new balance 990',    refPrice: 185,   label: 'OfferUp — New Balance 990 (New)'  },
  { q: 'nike dunks',         refPrice: 110,   label: 'OfferUp — Nike Dunks (New)'       },
  // Designer
  { q: 'louis vuitton',      refPrice: 800,   label: 'OfferUp — LV (New)'               },
  { q: 'gucci',              refPrice: 600,   label: 'OfferUp — Gucci (New)'            },
  { q: 'supreme box logo',   refPrice: 200,   label: 'OfferUp — Supreme (New)'          },
];

// Build the OfferUp search URL — condition=1 is "New", sort=1 is price low→high
function buildUrl(query) {
  return 'https://offerup.com/search/?q=' + encodeURIComponent(query) + '&condition=1&sort=1';
}

async function scrape(minDiscountPct) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  console.log('[OfferUp] Starting NEW items scrape...');
  var deals = [];

  for (var i = 0; i < OFFERUP_SEARCHES.length; i++) {
    var search = OFFERUP_SEARCHES[i];
    var page = null;
    try {
      page = await newPage();
      var url = buildUrl(search.q);
      await goto(page, url);

      // Wait for listings
      await page.waitForSelector('[data-testid="listing-card"], [class*="ListingCard"], [class*="listingCard"]', {
        timeout: 20000,
      }).catch(function() {});
      await sleep(3000);

      // Dismiss location/cookie modals
      await page.evaluate(function() {
        var btns = document.querySelectorAll('button');
        btns.forEach(function(b) {
          var t = b.textContent.toLowerCase();
          if (t.includes('not now') || t.includes('dismiss') || t.includes('close') || t.includes('skip')) b.click();
        });
      }).catch(function() {});
      await sleep(800);

      var listings = await page.$$eval(
        '[data-testid="listing-card"], [class*="ListingCard"], [class*="listingCard"], [class*="item-card"]',
        function(cards) {
          return cards.slice(0, 30).map(function(card) {
            var titleEl = card.querySelector('[data-testid="listing-title"], [class*="title"], [class*="Title"], p, h3');
            var title = titleEl ? titleEl.textContent.trim() : null;

            var priceEl = card.querySelector('[data-testid="listing-price"], [class*="price"], [class*="Price"]');
            var priceStr = priceEl ? priceEl.textContent.trim() : null;

            var linkEl = card.querySelector('a[href*="/item/"], a[href*="offerup.com"], a');
            var href = linkEl ? linkEl.href : null;

            var imgEl = card.querySelector('img[src*="offerup"], img[src*="cdn"], img');
            var imgSrc = imgEl ? (imgEl.src || imgEl.dataset.src) : null;

            // Condition badge - should say "New"
            var condEl = card.querySelector('[data-testid="listing-condition"], [class*="condition"], [class*="Condition"]');
            var condition = condEl ? condEl.textContent.trim() : '';

            return { title: title, priceStr: priceStr, href: href, imgSrc: imgSrc, condition: condition };
          });
        }
      );

      console.log('[OfferUp] ' + search.label + ': ' + listings.length + ' listings');

      for (var j = 0; j < listings.length; j++) {
        var item = listings[j];
        if (!item.title || !item.priceStr) continue;

        // Skip if condition is explicitly NOT new
        var cond = (item.condition || '').toLowerCase();
        if (cond && cond !== 'new' && cond !== '') continue;

        var price = parsePrice(item.priceStr);
        if (!price || price <= 0 || price < 5) continue;

        var refPrice = search.refPrice;

        // Skip if price is above reference (not a deal)
        if (price >= refPrice) continue;

        var discountPct = ((refPrice - price) / refPrice) * 100;

        if (discountPct >= minDiscountPct) {
          var url2 = item.href ? (item.href.startsWith('http') ? item.href : 'https://offerup.com' + item.href) : url;
          console.log('[OfferUp] DEAL: ' + item.title + ' — $' + price + ' (vs ~$' + refPrice + ' retail, ' + Math.round(discountPct) + '% off)');
          deals.push({
            productId:   'offerup_' + Buffer.from(url2).toString('base64').slice(0, 20),
            retailer:    'OfferUp',
            name:        item.title,
            url:         url2,
            imageUrl:    item.imgSrc || null,
            price:       price,
            normalPrice: refPrice,
            discountPct: discountPct,
            source:      search.label,
          });
        }
      }

    } catch (err) {
      console.error('[OfferUp] Error on ' + search.label + ': ' + err.message);
    } finally {
      if (page) await page.context().close().catch(function() {});
    }

    await sleep(3000);
  }

  console.log('[OfferUp] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
