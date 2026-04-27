const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://www.nordstromrack.com/shop/Clearance', label: 'Clearance' },
  { url: 'https://www.nordstromrack.com/shop/Women/Shoes/Clearance', label: 'Womens Shoes' },
  { url: 'https://www.nordstromrack.com/shop/Men/Shoes/Clearance', label: 'Mens Shoes' },
  { url: 'https://www.nordstromrack.com/shop/Women/Clothing/Clearance', label: 'Womens Clothing' },
  { url: 'https://www.nordstromrack.com/shop/Men/Clothing/Clearance', label: 'Mens Clothing' },
];

async function scrape(minDiscountPct = 40) {
  console.log('[Nordstrom Rack] Starting...');
  const deals = [];

  for (const target of TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await sleep(3000);
      await page.evaluate(() => window.scrollBy(0, 1500));
      await sleep(1500);

      const products = await page.$$eval('[data-testid="product-card"],[class*="ProductCard"],article', (cards) => cards.slice(0, 40).map((card) => {
        const name = card.querySelector('[data-testid="product-title"],[class*="title"],h3,h4')?.textContent?.trim()?.substring(0, 80);
        const priceStr = card.querySelector('[data-testid="current-price"],[class*="currentPrice"],[class*="salePrice"]')?.textContent?.trim();
        const wasStr = card.querySelector('[data-testid="original-price"],[class*="originalPrice"],del,s')?.textContent?.trim();
        const url = card.querySelector('a')?.href || '';
        const imgSrc = card.querySelector('img')?.src;
        return { name, priceStr, wasStr, url, imgSrc };
      }));

      console.log('[Nordstrom Rack] ' + target.label + ': ' + products.length + ' items');

      for (const product of products) {
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price || !was || was <= price) continue;

        const disc = ((was - price) / was) * 100;
        if (disc >= minDiscountPct) {
          deals.push({
            productId: 'nrack_' + Buffer.from(product.url || product.name).toString('base64').slice(0, 20),
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

    await sleep(3000);
  }

  console.log('[Nordstrom Rack] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
