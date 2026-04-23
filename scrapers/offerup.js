// ============================================================
//  scrapers/offerup.js — OfferUp Arbitrage Finder
//
//  Strategy: people on OfferUp underprice NEW items they don't
//  want. We buy them cheap and flip on eBay / StockX / Amazon
//  where the same item sells at full market value.
//
//  flipPrice = what you can realistically sell it for
//  refPrice  = same (what the market pays on eBay/StockX)
//  Alert fires when OfferUp price leaves enough profit margin.
//
//  condition=1 → New only
//  sort=1      → Lowest price first
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

// Each entry has:
//   q         — search term
//   flipPrice — what this sells for on eBay/StockX/Amazon right now
//   flipWhere — where to resell it
//   label     — display name
const OFFERUP_FLIPS = [
  // ── Sneakers (StockX resale prices) ────────────────────────
  { q: 'jordan 1 retro high',    flipPrice: 250,  flipWhere: 'StockX/eBay',  label: 'Jordan 1 High (New)'           },
  { q: 'jordan 4',               flipPrice: 280,  flipWhere: 'StockX/eBay',  label: 'Jordan 4 (New)'                },
  { q: 'yeezy 350',              flipPrice: 260,  flipWhere: 'StockX/eBay',  label: 'Yeezy 350 (New)'               },
  { q: 'yeezy 700',              flipPrice: 200,  flipWhere: 'StockX/eBay',  label: 'Yeezy 700 (New)'               },
  { q: 'new balance 550',        flipPrice: 130,  flipWhere: 'StockX/eBay',  label: 'New Balance 550 (New)'         },
  { q: 'new balance 990',        flipPrice: 185,  flipWhere: 'StockX/eBay',  label: 'New Balance 990 (New)'         },
  { q: 'nike dunk low',          flipPrice: 120,  flipWhere: 'StockX/eBay',  label: 'Nike Dunk Low (New)'           },
  { q: 'travis scott nike',      flipPrice: 400,  flipWhere: 'StockX/eBay',  label: 'Travis Scott (New)'            },
  { q: 'off white nike',         flipPrice: 350,  flipWhere: 'StockX/eBay',  label: 'Off-White Nike (New)'          },
  { q: 'sacai nike',             flipPrice: 280,  flipWhere: 'StockX/eBay',  label: 'Sacai Nike (New)'              },
  // ── Electronics (eBay sold listings) ───────────────────────
  { q: 'iphone 15 pro',          flipPrice: 750,  flipWhere: 'eBay/Swappa',  label: 'iPhone 15 Pro (New)'           },
  { q: 'iphone 16',              flipPrice: 700,  flipWhere: 'eBay/Swappa',  label: 'iPhone 16 (New)'               },
  { q: 'macbook air m2',         flipPrice: 900,  flipWhere: 'eBay',         label: 'MacBook Air M2 (New)'          },
  { q: 'macbook air m3',         flipPrice: 1000, flipWhere: 'eBay',         label: 'MacBook Air M3 (New)'          },
  { q: 'samsung galaxy s24',     flipPrice: 600,  flipWhere: 'eBay/Swappa',  label: 'Galaxy S24 (New)'              },
  { q: 'apple watch ultra',      flipPrice: 650,  flipWhere: 'eBay',         label: 'Apple Watch Ultra (New)'       },
  { q: 'airpods pro 2',          flipPrice: 180,  flipWhere: 'eBay',         label: 'AirPods Pro 2 (New)'           },
  { q: 'ipad pro',               flipPrice: 800,  flipWhere: 'eBay',         label: 'iPad Pro (New)'                },
  // ── Gaming (eBay) ───────────────────────────────────────────
  { q: 'playstation 5',          flipPrice: 430,  flipWhere: 'eBay',         label: 'PS5 (New)'                     },
  { q: 'xbox series x',          flipPrice: 400,  flipWhere: 'eBay',         label: 'Xbox Series X (New)'           },
  { q: 'steam deck oled',        flipPrice: 500,  flipWhere: 'eBay',         label: 'Steam Deck OLED (New)'         },
  { q: 'nintendo switch oled',   flipPrice: 280,  flipWhere: 'eBay',         label: 'Switch OLED (New)'             },
  // ── Streetwear / Designer (StockX/Grailed) ─────────────────
  { q: 'supreme box logo hoodie',flipPrice: 500,  flipWhere: 'StockX/Grailed', label: 'Supreme Box Logo (New)'      },
  { q: 'bape hoodie',            flipPrice: 280,  flipWhere: 'StockX/Grailed', label: 'Bape Hoodie (New)'           },
  { q: 'chrome hearts',          flipPrice: 400,  flipWhere: 'Grailed',       label: 'Chrome Hearts (New)'          },
  { q: 'stone island jacket',    flipPrice: 350,  flipWhere: 'Grailed/eBay',  label: 'Stone Island (New)'           },
];

function buildUrl(query) {
  return 'https://offerup.com/search/?q=' + encodeURIComponent(query) + '&condition=1&sort=1';
}

async function scrape(minDiscountPct) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  console.log('[OfferUp] Starting arbitrage scan — NEW items only...');
  var deals = [];

  for (var i = 0; i < OFFERUP_FLIPS.length; i++) {
    var item = OFFERUP_FLIPS[i];
    var page = null;
    try {
      page = await newPage();
      var url = buildUrl(item.q);
      await goto(page, url);

      await page.waitForSelector('[data-testid="listing-card"], [class*="ListingCard"], [class*="listingCard"]', {
        timeout: 20000,
      }).catch(function() {});
      await sleep(3000);

      // Dismiss modals
      await page.evaluate(function() {
        document.querySelectorAll('button').forEach(function(b) {
          var t = b.textContent.toLowerCase();
          if (t.includes('not now') || t.includes('dismiss') || t.includes('close') || t.includes('skip')) b.click();
        });
      }).catch(function() {});
      await sleep(800);

      var listings = await page.$$eval(
        '[data-testid="listing-card"], [class*="ListingCard"], [class*="listingCard"], [class*="item-card"]',
        function(cards) {
          return cards.slice(0, 24).map(function(card) {
            var titleEl = card.querySelector('[data-testid="listing-title"], [class*="title"], [class*="Title"], p, h3');
            var title = titleEl ? titleEl.textContent.trim() : null;

            var priceEl = card.querySelector('[data-testid="listing-price"], [class*="price"], [class*="Price"]');
            var priceStr = priceEl ? priceEl.textContent.trim() : null;

            var linkEl = card.querySelector('a[href*="/item/"], a');
            var href = linkEl ? linkEl.href : null;

            var imgEl = card.querySelector('img');
            var imgSrc = imgEl ? (imgEl.src || imgEl.dataset.src) : null;

            var condEl = card.querySelector('[class*="condition"], [class*="Condition"]');
            var condition = condEl ? condEl.textContent.trim().toLowerCase() : '';

            return { title: title, priceStr: priceStr, href: href, imgSrc: imgSrc, condition: condition };
          });
        }
      );

      console.log('[OfferUp] ' + item.label + ': ' + listings.length + ' listings');

      for (var j = 0; j < listings.length; j++) {
        var listing = listings[j];
        if (!listing.title || !listing.priceStr) continue;

        // Skip explicitly non-new items
        var cond = listing.condition || '';
        if (cond && cond !== 'new') continue;

        var askPrice = parsePrice(listing.priceStr);
        if (!askPrice || askPrice <= 0 || askPrice < 10) continue;

        // Skip if asking more than flip price (no profit)
        if (askPrice >= item.flipPrice) continue;

        var profit = item.flipPrice - askPrice;
        var discountPct = (profit / item.flipPrice) * 100;

        // Minimum $30 profit AND meets % threshold
        if (discountPct < minDiscountPct || profit < 30) continue;

        var listingUrl = listing.href
          ? (listing.href.startsWith('http') ? listing.href : 'https://offerup.com' + listing.href)
          : url;

        console.log('[OfferUp] FLIP: ' + listing.title + ' — Buy $' + askPrice + ' → Sell ~$' + item.flipPrice + ' on ' + item.flipWhere + ' (+$' + Math.round(profit) + ')');

        deals.push({
          productId:   'offerup_' + Buffer.from(listingUrl).toString('base64').slice(0, 20),
          retailer:    'OfferUp',
          name:        listing.title + ' [Flip → ' + item.flipWhere + ']',
          url:         listingUrl,
          imageUrl:    listing.imgSrc || null,
          price:       askPrice,
          normalPrice: item.flipPrice,
          discountPct: discountPct,
          source:      item.label + ' (+$' + Math.round(profit) + ' profit)',
        });
      }

    } catch (err) {
      console.error('[OfferUp] Error on ' + item.label + ': ' + err.message);
    } finally {
      if (page) await page.context().close().catch(function() {});
    }

    await sleep(2500);
  }

  console.log('[OfferUp] Done. ' + deals.length + ' flip opportunity(s) found.');
  return deals;
}

module.exports = { scrape };
