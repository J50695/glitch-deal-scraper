const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://slickdeals.net/deals/electronics/', label: 'Electronics' },
  { url: 'https://slickdeals.net/deals/computers/', label: 'Computers' },
  { url: 'https://slickdeals.net/deals/gaming/', label: 'Gaming' },
  { url: 'https://slickdeals.net/deals/clothing-accessories/', label: 'Clothing' },
  { url: 'https://slickdeals.net/deals/shoes/', label: 'Shoes' },
];

async function scrape(minDiscountPct = 40) {
  console.log('[Slickdeals] Starting...');
  const deals = [];

  for (const target of TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await sleep(2500);

      const products = await page.$$eval('[data-type="deal"],.dealCard,[class*="dealCard"],.deal-item', (cards) => cards.slice(0, 20).map((card) => {
        const name = card.querySelector('[class*="title"],[class*="dealTitle"],h3,h4,a')?.textContent?.trim()?.substring(0, 100);
        const priceStr = card.querySelector('[class*="price"],[class*="salePrice"]')?.textContent?.trim();
        const wasStr = card.querySelector('[class*="originalPrice"],[class*="wasPrice"],del,s')?.textContent?.trim();
        const store = card.querySelector('[class*="store"],[class*="merchant"]')?.textContent?.trim() || 'Unknown';
        const url = card.querySelector('a[href*="slickdeals"],a[href*="/f/"],a')?.href || '';
        return { name, priceStr, wasStr, store, url };
      }));

      console.log('[Slickdeals] ' + target.label + ': ' + products.length + ' items');

      for (const product of products) {
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price) continue;

        let disc = 0;
        let normal = was;
        if (was && was > price) disc = ((was - price) / was) * 100;

        if (disc >= minDiscountPct) {
          deals.push({
            productId: 'slick_' + Buffer.from(product.url || product.name).toString('base64').slice(0, 20),
            retailer: 'Slickdeals',
            name: product.name + ' (' + product.store + ')',
            url: product.url,
            imageUrl: null,
            price,
            normalPrice: normal || null,
            discountPct: disc,
            source: 'Slickdeals ' + target.label,
          });
        }
      }
    } catch (err) {
      console.error('[Slickdeals] Error on', target.label + ':', err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(2000);
  }

  console.log('[Slickdeals] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
