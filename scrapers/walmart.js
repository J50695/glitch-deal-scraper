// ============================================================
//  scrapers/walmart.js - Walmart Price Glitch Detector
//
//  Uses Walmart's internal search/category API endpoints
//  (same ones the website uses) to find deep discounts.
//  Falls back to Playwright if API is unavailable.
// ============================================================

const axios = require('axios');
const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

// Walmart category IDs to monitor
const WALMART_CATEGORIES = [
  // Existing
  { id: '3944',    name: 'Electronics'       },
  { id: '5438',    name: 'Video Games'       },
  { id: '4044',    name: 'Cell Phones'       },
  // Laptops & Computers
  { id: '1105910', name: 'Computers'         },
  { id: '3999',    name: 'Laptops'           },
  { id: '5448',    name: 'Desktops'          },
  { id: '23565',   name: 'Computer Monitors' },
  // TVs & Monitors
  { id: '1060825', name: 'TVs'              },
  { id: '4025',    name: '4K TVs'           },
  // Sneakers & Apparel
  { id: '2568990', name: 'Mens Shoes'       },
  { id: '2568991', name: 'Womens Shoes'     },
];

const WALMART_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.walmart.com/',
};

async function scrapePlaywright(minDiscountPct) {
  const targets = [
    { url: 'https://www.walmart.com/shop/deals/electronics',                      label: 'Walmart Electronics Deals'   },
    { url: 'https://www.walmart.com/cp/clearance/1228649',                        label: 'Walmart Clearance'           },
    { url: 'https://www.walmart.com/shop/deals/video-games',                      label: 'Walmart Video Games Deals'   },
    { url: 'https://www.walmart.com/browse/computers/laptops/3944_3951_132971',   label: 'Walmart Laptops'             },
    { url: 'https://www.walmart.com/browse/electronics/tvs/3944_1060825',         label: 'Walmart TVs'                 },
    { url: 'https://www.walmart.com/browse/clothing/mens-shoes/5438_2368404',     label: 'Walmart Mens Shoes'          },
    { url: 'https://www.walmart.com/browse/clothing/womens-shoes/5438_1045799',   label: 'Walmart Womens Shoes'        },
  ];

  const deals = [];

  for (const target of targets) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await page.waitForSelector('[data-item-id], [data-testid="list-view"], [data-testid="item-stack"]', { timeout: 20000 }).catch(() => {});
      await sleep(3000);

      const products = await page.$$eval(
        '[data-item-id], .search-result-gridview-item, [data-testid="item-stack"]',
        (cards) => cards.slice(0, 40).map(card => {
          const name  = card.querySelector('[itemprop="name"], .product-title-link span, [data-automation="product-title"]')?.textContent?.trim();
          const href  = card.querySelector('[itemprop="url"] a, .product-title-link, a[link-identifier]')?.href;
          const url   = href ? (href.startsWith('http') ? href : 'https://www.walmart.com' + href) : null;
          const priceEl  = card.querySelector('[itemprop="price"], [data-automation="product-price"], .price-main .visuallyhidden');
          const priceStr = priceEl?.getAttribute('content') || priceEl?.textContent?.trim();
          const wasEl  = card.querySelector('.price-old .visuallyhidden, .was-price, del .visuallyhidden, [data-testid="list-price"]');
          const wasStr = wasEl?.textContent?.trim();
          const saveEl  = card.querySelector('.price-savings-percentage, .rollback-save-msg, [data-testid="price-savings"]');
          const saveStr = saveEl?.textContent?.trim();
          const imgEl  = card.querySelector('img.product-image-photo, img[itemprop="image"], img[data-testid="productTileImage"]');
          const imgSrc = imgEl?.src;
          return { name, url, priceStr, wasStr, saveStr, imgSrc };
        })
      );

      console.log('[Walmart] ' + target.label + ': ' + products.length + ' items');

      for (const p of products) {
        if (!p.name || !p.url || !p.priceStr) continue;
        const price    = parsePrice(p.priceStr);
        const wasPrice = parsePrice(p.wasStr);
        if (!price) continue;
        let discountPct = 0;
        let normalPrice = wasPrice;
        if (wasPrice && wasPrice > price) { discountPct = ((wasPrice - price) / wasPrice) * 100; }
        else if (p.saveStr) { const m = p.saveStr.match(/(\d+)%/); if (m) discountPct = parseInt(m[1]); }
        if (discountPct >= minDiscountPct) {
          deals.push({
            productId:   'walmart_' + Buffer.from(p.url).toString('base64').slice(0, 20),
            retailer:    'Walmart', name: p.name, url: p.url,
            imageUrl:    p.imgSrc || null, price,
            normalPrice: normalPrice || null, discountPct,
            source:      target.label,
          });
        }
      }
    } catch (err) { console.error('[Walmart] Error on ' + target.label + ':', err.message); }
    finally { if (page) await page.context().close().catch(() => {}); }
    await sleep(4000);
  }
  return deals;
}

async function scrape(minDiscountPct = 70) {
  console.log('[Walmart] Starting scrape...');
  const deals = await scrapePlaywright(minDiscountPct);
  console.log('[Walmart] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
