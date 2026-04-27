const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://www.6pm.com/men-shoes?s=isCloseout/desc/goLiveDate/desc', label: 'Mens Shoes' },
  { url: 'https://www.6pm.com/women-shoes?s=isCloseout/desc/goLiveDate/desc', label: 'Womens Shoes' },
  { url: 'https://www.6pm.com/sneakers?s=isCloseout/desc/goLiveDate/desc', label: 'Sneakers' },
  { url: 'https://www.6pm.com/men-clothing?s=isCloseout/desc/goLiveDate/desc', label: 'Mens Clothing' },
];

async function scrape(minDiscountPct = 40) {
  console.log('[6pm] Starting...');
  const deals = [];

  for (const target of TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await sleep(3000);

      const products = await page.$$eval('article,[class*="product"],[data-product-id]', (cards) => cards.slice(0, 30).map((card) => {
        const name = card.querySelector('[class*="productName"],[class*="product-name"],h3,h4')?.textContent?.trim()?.substring(0, 80);
        const priceStr = card.querySelector('[class*="salePrice"],[class*="sale-price"]')?.textContent?.trim();
        const wasStr = card.querySelector('[class*="originalRetailPrice"],[class*="original"],del,s')?.textContent?.trim();
        const url = card.querySelector('a')?.href || '';
        const imgSrc = card.querySelector('img')?.src;
        return { name, priceStr, wasStr, url, imgSrc };
      }));

      console.log('[6pm] ' + target.label + ': ' + products.length + ' items');

      for (const product of products) {
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price || !was || was <= price) continue;

        const disc = ((was - price) / was) * 100;
        if (disc >= minDiscountPct) {
          deals.push({
            productId: 'sixpm_' + Buffer.from(product.url || product.name).toString('base64').slice(0, 20),
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

    await sleep(3000);
  }

  console.log('[6pm] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
