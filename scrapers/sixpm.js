const { newPage, goto, parsePrice, sleep } = require('./playwright-base');
const { buildProductId } = require('../lib/product-id');

const TARGETS = [
  { url: 'https://www.6pm.com/men-shoes?s=isCloseout/desc/goLiveDate/desc', label: 'Mens Shoes' },
  { url: 'https://www.6pm.com/women-shoes?s=isCloseout/desc/goLiveDate/desc', label: 'Womens Shoes' },
  { url: 'https://www.6pm.com/sneakers?s=isCloseout/desc/goLiveDate/desc', label: 'Sneakers' },
  { url: 'https://www.6pm.com/men-clothing?s=isCloseout/desc/goLiveDate/desc', label: 'Mens Clothing' },
];

async function scrape(minDiscountPct = 40, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[6pm] Starting...');
  const deals = [];
  let emptyTargets = 0;

  for (const target of TARGETS) {
    if (isAborted()) {
      console.warn('[6pm] Aborted before starting ' + target.label);
      break;
    }

    let page;
    try {
      page = await newPage();
      await goto(page, target.url, { timeout: 15000 });
      await page.waitForSelector('article a[href*="/product/"], article a[href*="/p/"]', { timeout: 8000 }).catch(() => {});
      await sleep(1500);

      const products = await page.$$eval('article', (cards) => cards.slice(0, 60).map((card) => {
        const detailLink = card.querySelector('a[href*="/product/"], a[href*="/p/"]');
        const brand = card.querySelector('.NQ-z span, [data-testid="brand-name"]')?.textContent?.trim();
        const product = card.querySelector('.OQ-z, [data-testid="product-name"]')?.textContent?.trim();
        const name = [brand, product].filter(Boolean).join(' - ') || detailLink?.getAttribute('title')?.trim();
        const priceStr = card.querySelector('.V4-z, [data-testid="price"]')?.textContent?.trim()
          || detailLink?.textContent?.match(/On sale for \\$[\\d,.]+/i)?.[0]?.replace(/On sale for /i, '')
          || null;
        const wasStr = card.querySelector('.Z4-z, [data-testid="original-price"]')?.textContent?.trim()
          || detailLink?.textContent?.match(/MSRP \\$[\\d,.]+/i)?.[0]?.replace(/MSRP:? /i, '')
          || null;
        const url = detailLink?.href || '';
        const imgSrc = card.querySelector('img')?.src || null;
        return { name, priceStr, wasStr, url, imgSrc };
      }).filter((item) => item.url));

      console.log('[6pm] ' + target.label + ': ' + products.length + ' items');

      if (products.length === 0) {
        emptyTargets += 1;
        if (emptyTargets >= 2) {
          console.warn('[6pm] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

      for (const product of products) {
        if (isAborted()) {
          console.warn('[6pm] Aborted during ' + target.label);
          break;
        }
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price || !was || was <= price) continue;

        const disc = ((was - price) / was) * 100;
        if (disc >= minDiscountPct) {
          deals.push({
            productId: buildProductId('sixpm', product.url || product.name),
            retailer: '6pm',
            name: product.name,
            url: product.url,
            imageUrl: product.imgSrc || null,
            price,
            normalPrice: was,
            discountPct: disc,
            source: '6pm ' + target.label,
          });
        }
      }
    } catch (err) {
      console.error('[6pm] Error on', target.label + ':', err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    if (isAborted()) break;
    await sleep(1200);
  }

  console.log('[6pm] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
