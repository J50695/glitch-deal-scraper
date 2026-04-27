const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGETS = [
  { url: 'https://www.newegg.com/Shell-Shocker/EventSaleStore/ID-10381?cm_sp=homepage-pers-home+shell+shocker', label: 'Shell Shocker' },
  { url: 'https://www.newegg.com/Clearance-Store/Store/ID-697', label: 'Clearance' },
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

      const products = await page.evaluate(() => {
        const seen = new Set();
        const parseCards = (cards, extract) => cards.map(extract).filter(Boolean).filter(item => {
          if (!item.url || seen.has(item.url)) return false;
          seen.add(item.url);
          return true;
        });

        const legacyCards = Array.from(document.querySelectorAll('.item-cell,[class*="item-cell"],.item-container'));
        const legacy = parseCards(legacyCards, (card) => {
          const name = card.querySelector('.item-title,[class*="item-title"]')?.textContent?.trim()?.substring(0, 100);
          const priceStr = card.querySelector('.price-current,[class*="price-current"]')?.textContent?.trim();
          const wasStr = card.querySelector('.price-was,[class*="price-was"],del')?.textContent?.trim();
          const url = card.querySelector('a.item-title,a')?.href || '';
          const imgSrc = card.querySelector('img')?.src || null;
          if (!name || !url) return null;
          return { name, priceStr, wasStr, url, imgSrc };
        });

        if (legacy.length > 0) return legacy;

        const modernCards = Array.from(document.querySelectorAll('.goods-container'));
        return parseCards(modernCards, (card) => {
          const titleLink = card.querySelector('a.goods-title');
          const name = titleLink?.textContent?.trim()?.substring(0, 140);
          const url = titleLink?.href || card.querySelector('a.goods-img')?.href || '';
          const priceStr = card.querySelector('.price-current,[class*="price-current"], .goods-price-current, .price-current strong')?.textContent?.trim()
            || card.textContent?.match(/\$\s*\d[\d,]*(?:\.\d{2})?/)?.[0]
            || '';
          const wasStr = card.textContent?.match(/\$\d[\d,]*\.\d{2}/g)?.[1] || '';
          const imgSrc = card.querySelector('img')?.src || null;
          if (!name || !url) return null;
          return { name, priceStr, wasStr, url, imgSrc };
        });
      });

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
