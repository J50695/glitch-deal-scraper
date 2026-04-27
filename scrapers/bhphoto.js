const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://www.bhphotovideo.com/c/used/all/BI/14286', label: 'Used All' },
  { url: 'https://www.bhphotovideo.com/c/used/cameras-photo/BI/7', label: 'Used Cameras' },
  { url: 'https://www.bhphotovideo.com/c/used/computers-solutions/BI/8', label: 'Used Computers' },
];

async function scrape(minDiscountPct = 40) {
  console.log('[B&H Photo] Starting...');
  const deals = [];

  for (const target of TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await sleep(2500);

      const products = await page.$$eval('[data-selenium="miniProductPage"],[class*="productCard"]', (cards) => cards.map((card) => {
        const name = (card.querySelector('[data-selenium="miniProductPageProductName"],[class*="title"]')?.textContent || '').trim();
        const priceStr = card.querySelector('[class*="actualPrice"],[class*="price"]')?.textContent?.trim();
        const wasStr = card.querySelector('[class*="originalPrice"],del')?.textContent?.trim();
        const url = card.querySelector('a')?.href || '';
        const imgSrc = card.querySelector('img')?.src;
        return { name, priceStr, wasStr, url, imgSrc };
      }));

      console.log('[B&H Photo] ' + target.label + ': ' + products.length + ' items');

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
