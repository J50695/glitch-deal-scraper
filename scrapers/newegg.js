const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://www.newegg.com/tools/daily-deals', label: 'Daily Deals' },
  { url: 'https://www.newegg.com/clearance', label: 'Clearance' },
  { url: 'https://www.newegg.com/Laptops-Notebooks/SubCategory/ID-32/Price-100-500', label: 'Laptops' },
  { url: 'https://www.newegg.com/open-box', label: 'Open Box' },
];

async function scrape(minDiscountPct = 40) {
  console.log('[Newegg] Starting...');
  const deals = [];

  for (const target of TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await sleep(2500);

      const products = await page.$$eval('.item-cell,[class*="item-cell"],.item-container', (cards) => cards.map((card) => {
        const name = card.querySelector('.item-title,[class*="item-title"]')?.textContent?.trim()?.substring(0, 100);
        const priceStr = card.querySelector('.price-current,[class*="price-current"]')?.textContent?.trim();
        const wasStr = card.querySelector('.price-was,[class*="price-was"],del')?.textContent?.trim();
        const url = card.querySelector('a.item-title,a')?.href || '';
        const imgSrc = card.querySelector('img')?.src;
        return { name, priceStr, wasStr, url, imgSrc };
      }));

      console.log('[Newegg] ' + target.label + ': ' + products.length + ' items');

      for (const product of products) {
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price || !was || was <= price) continue;

        const disc = ((was - price) / was) * 100;
        if (disc >= minDiscountPct) {
          deals.push({
            productId: 'newegg_' + Buffer.from(product.url || product.name).toString('base64').slice(0, 20),
            retailer: 'Newegg',
            name: product.name,
            url: product.url,
            imageUrl: product.imgSrc || null,
            price,
            normalPrice: was,
            discountPct: disc,
            source: 'Newegg ' + target.label,
          });
        }
      }
    } catch (err) {
      console.error('[Newegg] Error on', target.label + ':', err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(2000);
  }

  console.log('[Newegg] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
