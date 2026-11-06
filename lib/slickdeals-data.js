const { buildProductId } = require('./product-id');

function money(text) {
  const match = String(text || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function readValue(table, ref) {
  for (let depth = 0; depth < 8; depth++) {
    const value = table[ref];
    if (Array.isArray(value) && ['Ref', 'ShallowRef', 'Reactive', 'ShallowReactive'].includes(value[0])) {
      ref = value[1];
      continue;
    }
    return value;
  }
  return null;
}

function parseSlickdealsHtml(html, { now = Date.now(), maxAgeDays = 7 } = {}) {
  const match = String(html).match(/<script\b[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let table;
  try { table = JSON.parse(match[1]); } catch { return null; }
  if (!Array.isArray(table)) return null;
  const deals = [];
  const seen = new Set();
  for (const row of table) {
    if (!row || typeof row !== 'object' || !('dealTitle' in row) || !('finalPriceText' in row)) continue;
    const field = (key) => readValue(table, row[key]);
    if (field('isExpired') === true) continue;
    const postedAt = Date.parse(field('threadIsoDatetime'));
    if (Number.isFinite(postedAt) && now - postedAt > maxAgeDays * 86400000) continue;
    const name = field('dealTitle');
    const href = field('dealThreadUrl');
    let price = money(field('finalPriceText'));
    if (typeof name !== 'string' || typeof href !== 'string' || !price) continue;
    const url = new URL(href, 'https://slickdeals.net').href;
    if (!url.startsWith('https://slickdeals.net/f/') || seen.has(url)) continue;
    // Some cards round the displayed price; use title cents only when they agree.
    const titlePrices = [...name.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    const exactPrice = titlePrices.find((n) => n > 0 && Math.abs(n - price) <= 0.51);
    if (exactPrice != null) price = exactPrice;
    const normalPrice = money(field('listPriceText'));
    const discountPct = normalPrice > price ? (normalPrice - price) / normalPrice * 100 : 0;
    seen.add(url);
    deals.push({
      productId: buildProductId('slick', url),
      retailer: 'Slickdeals', merchant: field('storeName') || null,
      name, url, imageUrl: field('dealImageUrl') || null,
      price, normalPrice: normalPrice > price ? normalPrice : null, discountPct,
      postedAt: Number.isFinite(postedAt) ? new Date(postedAt).toISOString() : null,
    });
  }
  return deals;
}

module.exports = { parseSlickdealsHtml };
