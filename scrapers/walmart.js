// ============================================================
//  scrapers/walmart.js â Walmart Price Glitch Detector
//
//  Uses Walmart's internal search/category API endpoints
//  (same ones the website uses) to find deep discounts.
//  Falls back to Playwright if API is unavailable.
// ============================================================

const axios = require('axios');
const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

// Walmart category IDs to monitor
const WALMART_CATEGORIES = [
  { id: '3944', name: 'Electronics'    },
  { id: '5438', name: 'Video Games'    },
  { id: '1105910', name: 'Computers'   },
  { id: '4044', name: 'Cell Phones'    },
  { id: '5438', name: 'Toys & Games'   },
];

const WALMART_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.walmart.com/',
};

/**
 * Fetch products from Walmart's internal API.
 * This is the same API the walmart.com frontend uses.
 */
async function fetchCategoryApi(categoryId, sort = 'price_low') {
  try {
    const url = `https://www.walmart.com/search?cat_id=${categoryId}&facet=price%3A%240+%E2%80%93+%2425&sort=${sort}&limit=40`;
    const res = await axios.get(url, {
      headers: {
        ...WALMART_HEADERS,
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    });

    // Extract the JSON from the __NEXT_DATA__ script tag
    const match = res.data.match(/"initialData":\s*\{.*?"searchResult":\{(.*?)\},"searchIntent"/s);
    if (!match) return [];

    // Alternatively, use the direct API
    const apiRes = await axios.get(
      `https://www.walmart.com/api/2.0/page/category?pageId=${categoryId}&pref=browse&limit=40`,
      { headers: WALMART_HEADERS, timeout: 15000 }
    );

    const items = apiRes.data?.payload?.products?.products || [];
    return items;

  } catch (err) {
    return [];
  }
}

/**
 * Scrape Walmart's clearance/rollback pages via Playwright.
 */
async function scrapePlaywright(minDiscountPct) {
  const targets = [
    { url: 'https://www.walmart.com/shop/deals/electronics',  label: 'Walmart Electronics Deals' },
    { url: 'https://www.walmart.com/cp/clearance/1228649',    label: 'Walmart Clearance'          },
    { url: 'https://www.walmart.com/shop/deals/video-games',  label: 'Walmart Video Games Deals'  },
  ];

  const deals = [];

  for (const target of targets) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await page.waitForSelector('[data-item-id], [data-testid="list-view"]', { timeout: 20000 }).catch(() => {});
      await sleep(3000);

      const products = await page.$$eval(
        '[data-item-id], .search-result-gridview-item',
        (cards) => cards.slice(0, 40).map(card => {
          const name  = card.querySelector('[itemprop="name"], .product-title-link span')?.textContent?.trim();
          const href  = card.querySelector('[itemprop="url"] a, .product-title-link')?.href;
          const url   = href ? (href.startsWith('http') ? href : 'https://www.walmart.com' + href) : null;

          // Current price
          const priceEl = card.querySelector('[itemprop="price"], .price-main .visuallyhidden, [data-automation="product-price"]');
          const priceStr = priceEl?.getAttribute('content') || priceEl?.textContent?.trim();

          // Was / list price
          const wasEl  = card.querySelector('.price-old .visuallyhidden, .was-price, del .visuallyhidden');
          const wasStr = wasEl?.textContent?.trim();

          // Savings %
          const saveEl  = card.querySelector('.price-savings-percentage, .rollback-save-msg');
          const saveStr = saveEl?.textContent?.trim();

          const imgEl  = card.querySelector('img.product-image-photo, img[itemprop="image"]');
          const imgSrc = imgEl?.src;

          return { name, url, priceStr, wasStr, saveStr, imgSrc };
        })
      );

      console.log(`[Walmart] ${target.label}: ${products.length} items`);

      for (const p of products) {
        if (!p.name || !p.url || !p.priceStr) continue;
        const price    = parsePrice(p.priceStr);
        const wasPrice = parsePrice(p.wasStr);
        if (!price) continue;

        let discountPct = 0;
        let normalPrice = wasPrice;

        if (wasPrice && wasPrice > price) {
          discountPct = ((wasPrice - price) / wasPrice) * 100;
        } else if (p.saveStr) {
          const m = p.saveStr.match(/(\d+)%/);
          if (m) discountPct = parseInt(m[1]);
        }

        if (discountPct >= minDiscountPct) {
          console.log(`[Walmart] ð¥ ${p.name} â $${price} (${Math.round(discountPct)}% off)`);
          deals.push({
            productId:   `walmart_${Buffer.from(p.url).toString('base64').slice(0, 20)}`,
            retailer:    'Walmart',
            name:        p.name,
            url:         p.url,
            imageUrl:    p.imgSrc || null,
            price,
            normalPrice: normalPrice || null,
            discountPct,
            source:      target.label,
          });
        }
      }

    } catch (err) {
      console.error(`[Walmart] Error: ${err.message}`);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(4000);
  }

  return deals;
}

async function scrape(minDiscountPct = 70) {
  console.log('[Walmart] Starting scrape...');
  const deals = await scrapePlaywright(minDiscountPct);
  console.log(`[Walmart] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
