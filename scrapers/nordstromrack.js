const axios = require('axios');
const { newPage, goto, parsePrice, sleep } = require('./playwright-base');
const { buildProductId } = require('../lib/product-id');

const TARGETS = [
  { url: 'https://www.nordstromrack.com/shop/Clearance', label: 'Clearance' },
  { url: 'https://www.nordstromrack.com/shop/Women/Shoes/Clearance', label: 'Womens Shoes' },
  { url: 'https://www.nordstromrack.com/shop/Men/Shoes/Clearance', label: 'Mens Shoes' },
];

const LINK_SELECTOR = 'a[href*="/s/"]';

async function isHardBlocked(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Accept': 'text/html',
      },
      validateStatus: () => true,
    });
    const html = String(res.data || '').toLowerCase().replace(/\s+/g, ' ');
    return html.includes("window['istlwashere']") || (html.includes('<title></title>') && html.length > 100000);
  } catch {
    return false;
  }
}

async function scrape(minDiscountPct = 40, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[Nordstrom Rack] Starting...');
  const deals = [];
  let emptyTargets = 0;

  for (const target of TARGETS) {
    if (isAborted()) {
      console.warn('[Nordstrom Rack] Aborted before starting ' + target.label);
      break;
    }

    let page;
    try {
      if (await isHardBlocked(target.url)) {
        console.log('[Nordstrom Rack] ' + target.label + ': blocked by anti-bot shell at HTTP layer');
        break;
      }

      page = await newPage();
      await goto(page, target.url, { timeout: 12000 });
      await page.waitForSelector(LINK_SELECTOR, { timeout: 5000 }).catch(() => {});
      await sleep(800);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2)).catch(() => {});
      await sleep(500);

      const products = await page.$$eval(LINK_SELECTOR, (links) => {
        const seen = new Set();
        const items = [];
        for (const link of links) {
          const url = link.href || '';
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const card = link.closest('[data-testid="product-card"], [class*="ProductCard"], article, li, div');
          if (!card) continue;
          const brand = card.querySelector('[data-testid="product-brand"], [class*="brand"], h4')?.textContent?.trim();
          const title = card.querySelector('[data-testid="product-title"], [class*="title"], h3')?.textContent?.trim();
          const name = [brand, title].filter(Boolean).join(' - ') || link.textContent?.trim()?.slice(0, 80);
          const priceStr = card.querySelector('[data-testid="current-price"], [class*="currentPrice"], [class*="salePrice"]')?.textContent?.trim();
          const wasStr = card.querySelector('[data-testid="original-price"], [class*="originalPrice"], del, s')?.textContent?.trim();
          const imgSrc = card.querySelector('img')?.src || null;
          items.push({ name, priceStr, wasStr, url, imgSrc });
          if (items.length >= 60) break;
        }
        return items;
      });

      console.log('[Nordstrom Rack] ' + target.label + ': ' + products.length + ' items');

      if (products.length === 0) {
        emptyTargets += 1;
        if (emptyTargets >= 2) {
          console.warn('[Nordstrom Rack] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

      for (const product of products) {
        if (isAborted()) {
          console.warn('[Nordstrom Rack] Aborted during ' + target.label);
          break;
        }
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price || !was || was <= price) continue;

        const disc = ((was - price) / was) * 100;
        if (disc >= minDiscountPct) {
          deals.push({
            productId: buildProductId('nrack', product.url || product.name),
            retailer: 'Nordstrom Rack',
            name: product.name,
            url: product.url,
            imageUrl: product.imgSrc || null,
            price,
            normalPrice: was,
            discountPct: disc,
            source: 'Nordstrom Rack ' + target.label,
          });
        }
      }
    } catch (err) {
      console.error('[Nordstrom Rack] Error on', target.label + ':', err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    if (isAborted()) break;
    await sleep(900);
  }

  console.log('[Nordstrom Rack] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
