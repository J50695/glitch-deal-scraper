const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://www.bhphotovideo.com/c/buy/SLR-Digital-Cameras/ci/15488/N/4294182649', label: 'Used DSLR Cameras' },
  { url: 'https://www.bhphotovideo.com/c/buy/Point-Shoot-Digital-Cameras/ci/15487', label: 'Used Point & Shoot' },
  { url: 'https://www.bhphotovideo.com/c/buy/used-other-computer-components-accessories/ci/60580', label: 'Used Computer Accessories' },
];

async function scrape(minDiscountPct = 40) {
  console.log('[B&H Photo] Starting...');
  const deals = [];
  let emptyPages = 0;

  for (const target of TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await sleep(4000);

      const products = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[data-selenium="miniProductPage"],[class*="productCard"],a[href*="/c/product/"]'));
        const seen = new Set();
        return cards.map((node) => {
          const card = node.closest?.('[data-selenium="miniProductPage"],[class*="productCard"]') || node;
          const link = card.matches?.('a[href*="/c/product/"]') ? card : card.querySelector('a[href*="/c/product/"], a');
          const url = link?.href || '';
          if (!url || seen.has(url)) return null;
          seen.add(url);

          const name = (card.querySelector('[data-selenium="miniProductPageProductName"],[class*="title"],h3,h4')?.textContent || link?.textContent || '').trim();
          const priceStr = card.querySelector('[class*="actualPrice"],[class*="price"]')?.textContent?.trim() || '';
          const wasStr = card.querySelector('[class*="originalPrice"],del,s')?.textContent?.trim() || '';
          const imgSrc = card.querySelector('img')?.src || null;
          if (!name) return null;
          return { name, priceStr, wasStr, url, imgSrc };
        }).filter(Boolean);
      });

      console.log('[B&H Photo] ' + target.label + ': ' + products.length + ' items');
      if (products.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) {
          console.warn('[B&H Photo] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyPages = 0;
      }

      for (const product of products) {
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price || !was || was <= price) continue;

        const disc = ((was - price) / was) * 100;
        if (disc >= minDiscountPct) {
          deals.push({
            productId: 'bhphoto_' + Buffer.from(product.url || product.name).toString('base64').slice(0, 20),
            retailer: 'B&H Photo',
            name: product.name,
            url: product.url,
            imageUrl: product.imgSrc || null,
            price,
            normalPrice: was,
            discountPct: disc,
            source: 'B&H Photo ' + target.label,
          });
        }
      }
    } catch (err) {
      console.error('[B&H Photo] Error on', target.label + ':', err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(2000);
  }

  console.log('[B&H Photo] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
