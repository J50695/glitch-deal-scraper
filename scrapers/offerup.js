const { newPage, goto, parsePrice, sleep } = require('./playwright-base');
const { buildProductId } = require('../lib/product-id');

const TERMS = [
  { q: 'Jordan 1 High', flip: 280, label: 'Jordan 1 High' },
  { q: 'Jordan 4 Retro', flip: 250, label: 'Jordan 4 Retro' },
  { q: 'Yeezy 350 V2', flip: 220, label: 'Yeezy 350 V2' },
  { q: 'Nike Dunk Low', flip: 120, label: 'Nike Dunk Low' },
  { q: 'New Balance 550', flip: 130, label: 'New Balance 550' },
  { q: 'iPhone 15 Pro', flip: 750, label: 'iPhone 15 Pro' },
  { q: 'MacBook Air M2', flip: 900, label: 'MacBook Air M2' },
  { q: 'PS5 console', flip: 380, label: 'PS5' },
  { q: 'Xbox Series X', flip: 350, label: 'Xbox Series X' },
  { q: 'Nintendo Switch OLED', flip: 250, label: 'Switch OLED' },
  { q: 'AirPods Pro 2', flip: 180, label: 'AirPods Pro 2' },
];

async function scrape(minDiscountPct = 40, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[OfferUp] Starting...');
  const deals = [];
  let page;
  let emptySearches = 0;

  try {
    page = await newPage();
    for (const term of TERMS) {
      if (isAborted()) {
        console.warn('[OfferUp] Aborted before starting ' + term.label);
        break;
      }
      try {
        const url = 'https://offerup.com/search?q=' + encodeURIComponent(term.q) + '&sort=1';
        await goto(page, url, { timeout: 15000 });
        await page.waitForSelector('a[href*="/item/detail/"]', { timeout: 7000 }).catch(() => {});
        await sleep(1500);

        const items = await page.$$eval('a[href*="/item/detail/"]', (links) => links.slice(0, 48).map((link) => {
          const card = link.closest('li, article, div');
          const name = card?.querySelector('[class*="MuiTypography-subtitle1"]')?.textContent?.trim()
            || link.getAttribute('title')?.trim()
            || '';
          const priceStr = card?.querySelector('[class*="MuiTypography-body1"]')?.textContent?.trim()
            || card?.textContent?.match(/\\$\\d[\\d,]*/)?.[0]
            || null;
          const imgSrc = card?.querySelector('img')?.src || null;
          return { name, priceStr, url: link.href || '', imgSrc };
        }).filter((item) => item.url));

        if (items.length === 0) {
          emptySearches++;
          if (emptySearches >= 3) {
            console.warn('[OfferUp] Repeated empty searches, stopping early.');
            break;
          }
        } else {
          emptySearches = 0;
        }

        for (const item of items) {
          if (isAborted()) {
            console.warn('[OfferUp] Aborted during ' + term.label);
            break;
          }
          const price = parsePrice(item.priceStr);
          if (!price || price <= 0) continue;

          const profit = term.flip - price;
          const disc = Math.round((profit / term.flip) * 100);
          if (profit >= 30) {
            deals.push({
              productId: buildProductId('offerup', item.url || term.q),
              retailer: 'OfferUp',
              name: (item.name || term.label) + ' [Flip +$' + Math.round(profit) + ']',
              url: item.url || 'https://offerup.com/search/?q=' + encodeURIComponent(term.q),
              imageUrl: item.imgSrc || null,
              price,
              normalPrice: term.flip,
              discountPct: disc,
              source: 'OfferUp → resale ~$' + term.flip,
            });
          }
        }
      } catch (err) {
        console.error('[OfferUp] Error on', term.label + ':', err.message);
      }

      if (isAborted()) break;
      await sleep(800);
    }
  } catch (err) {
    console.error('[OfferUp] Fatal:', err.message);
  } finally {
    if (page) await page.context().close().catch(() => {});
  }

  console.log('[OfferUp] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
