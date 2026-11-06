const { newPage, goto, parsePrice, sleep } = require('./playwright-base');
const { buildProductId } = require('../lib/product-id');
const axios = require('axios');
const { parseSlickdealsHtml } = require('../lib/slickdeals-data');

const TARGETS = [
  { url: 'https://slickdeals.net/deals/electronics/', label: 'Electronics' },
  { url: 'https://slickdeals.net/computer-deals/', label: 'Computers' },
  { url: 'https://slickdeals.net/deals/gaming/', label: 'Gaming' },
  { url: 'https://slickdeals.net/deals/clothing-accessories/', label: 'Clothing' },
  { url: 'https://slickdeals.net/deals/shoes/', label: 'Shoes' },
];

async function scrape(minDiscountPct = 40, options = {}) {
  const isAborted = options.isAborted || (() => false);
  const shopping = options.shoppingConfig;
  const targets = shopping?.mode === 'personal'
    ? shopping.rules.filter((rule) => rule.enabled !== false && rule.searchQuery).map((rule) => ({
      url: 'https://slickdeals.net/search?' + new URLSearchParams({ q: rule.searchQuery, sort: 'recent' }),
      label: rule.label,
    }))
    : TARGETS;
  console.log('[Slickdeals] Starting...');
  const deals = [];
  const seenIds = new Set();

  for (const target of targets) {
    if (isAborted()) break;
    let page;
    try {
      const response = await axios.get(target.url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } }).catch(() => null);
      const structured = response && parseSlickdealsHtml(response.data, { maxAgeDays: shopping?.maxDealAgeDays || 7 });
      if (isAborted()) break;
      if (structured !== null && structured !== false) {
        console.log('[Slickdeals] ' + target.label + ': ' + structured.length + ' active recent items');
        for (const deal of structured) {
          if (deal.discountPct < minDiscountPct || seenIds.has(deal.productId)) continue;
          seenIds.add(deal.productId);
          deals.push({ ...deal, source: 'Slickdeals ' + target.label });
        }
        continue;
      }
      // Search pages require current structured metadata to exclude expired posts.
      if (shopping?.mode === 'personal') {
        console.warn('[Slickdeals] Search data unavailable: ' + target.label);
        continue;
      }
      page = await newPage();
      await goto(page, target.url);
      await sleep(2500);

      const products = await page.$$eval('a.bp-c-card_title, [class*="card_title"]', (titleLinks) => {
        const seen = new Set();
        return titleLinks.map((link) => {
          const card = link.closest('[data-type="deal"], [class*="DealCard"], [class*="dealCard"], article, li');
          if (!card) return null;

          const url = link.href || '';
          if (!url || seen.has(url)) return null;
          seen.add(url);

          const name = link.textContent?.trim()?.substring(0, 160);
          const priceStr = card.querySelector('.bp-p-dealCard_price, [class*="dealCard_price"], [class*="salePrice"]')?.textContent?.trim();
          const wasStr = card.querySelector('.bp-p-dealCard_originalPrice, [class*="originalPrice"], [class*="wasPrice"], del, s')?.textContent?.trim();
          const store = card.querySelector('.bp-c-card_subtitle, [class*="card_subtitle"], [class*="store"], [class*="merchant"]')?.textContent?.trim() || 'Unknown';
          return { name, priceStr, wasStr, store, url };
        }).filter(Boolean);
      });

      console.log('[Slickdeals] ' + target.label + ': ' + products.length + ' items');

      for (const product of products) {
        if (isAborted()) break;
        if (!product.name || !product.priceStr) continue;
        const price = parsePrice(product.priceStr);
        const was = parsePrice(product.wasStr);
        if (!price) continue;

        let disc = 0;
        let normal = was;
        if (was && was > price) disc = ((was - price) / was) * 100;

        if (disc >= minDiscountPct) {
          const productId = buildProductId('slick', product.url || product.name);
          if (seenIds.has(productId)) continue;
          seenIds.add(productId);
          deals.push({
            productId,
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

    if (isAborted()) break;
    await sleep(1000);
  }

  console.log('[Slickdeals] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
