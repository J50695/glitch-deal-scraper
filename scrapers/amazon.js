// ============================================================
//  scrapers/amazon.js â Amazon via Keepa API
//
//  Keepa tracks Amazon price history for every product.
//  We query their API for products in deal categories and
//  flag anything that dropped 70%+ below its 90-day high.
//
//  Sign up: https://keepa.com/#!api  (free tier: 100 tokens/day)
//  Each product lookup costs ~3 tokens â ~30 products/day free
// ============================================================

require('dotenv').config();
const axios = require('axios');

const KEEPA_API_KEY  = process.env.KEEPA_API_KEY;
const KEEPA_BASE_URL = 'https://api.keepa.com';

// ââ Keepa domain codes ââââââââââââââââââââââââââââââââââââââââ
// 1=US, 2=UK, 3=DE, 4=FR, 5=JP, 8=CA, 9=IT, 10=ES, 11=IN, 12=MX
const DOMAIN = 1; // Amazon US

// ââ Categories to scan for potential glitches âââââââââââââââââ
// These are Keepa category IDs for high-value flip categories
const WATCH_CATEGORIES = [
  172282,  // Electronics
  1055398, // Video Games
  2625373, // Cell Phones & Accessories
  3012290, // Computers
  979233,  // Sports & Outdoors
  7141123, // Clothing, Shoes & Jewelry (high-level)
  11260432,// Shoes
];

// ââ Price conversion ââââââââââââââââââââââââââââââââââââââââââ
// Keepa stores prices as integers (multiply by 0.01 to get USD)
function keepaPrice(raw) {
  return raw > 0 ? raw / 100 : null;
}

/**
 * Get the 90-day high price and current price for an ASIN.
 * Returns null if product has no useful price data.
 */
async function getProductPriceData(asin) {
  if (!KEEPA_API_KEY) return null;

  try {
    const res = await axios.get(`${KEEPA_BASE_URL}/product`, {
      params: {
        key:        KEEPA_API_KEY,
        domain:     DOMAIN,
        asin:       asin,
        history:    1,
        days:       90,
      },
      timeout: 15000,
    });

    const product = res.data?.products?.[0];
    if (!product) return null;

    // csv[0] = Amazon price history (alternating: time, price, time, price...)
    const amazonPrices = product.csv?.[0];
    // csv[1] = Marketplace new price history
    const marketPrices = product.csv?.[1];

    const prices = parsePriceHistory(amazonPrices || marketPrices);
    if (prices.length < 2) return null;

    const current   = prices[prices.length - 1]?.price;
    const max90Day  = Math.max(...prices.map(p => p.price));
    const avg90Day  = prices.reduce((s, p) => s + p.price, 0) / prices.length;

    return {
      asin,
      name:      product.title || asin,
      url:       `https://www.amazon.com/dp/${asin}`,
      imageUrl:  product.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${product.imagesCSV.split(',')[0]}` : null,
      current:   current,
      max90Day:  max90Day,
      avg90Day:  avg90Day,
      allPrices: prices,
    };

  } catch (err) {
    console.error(`[Amazon/Keepa] Error fetching ASIN ${asin}:`, err.message);
    return null;
  }
}

/**
 * Parse Keepa's price history array into [{time, price}] pairs.
 * Keepa encodes: [timestamp1, price1, timestamp2, price2, ...]
 * Timestamps are "keepa minutes" since epoch / 60000
 */
function parsePriceHistory(csv) {
  if (!csv || csv.length < 2) return [];
  const result = [];
  for (let i = 0; i < csv.length - 1; i += 2) {
    const price = keepaPrice(csv[i + 1]);
    if (price && price > 0 && price < 99999) {
      result.push({ time: csv[i], price });
    }
  }
  return result;
}

/**
 * Search Keepa for products in a category that have recent price drops.
 * Returns array of ASINs worth checking.
 */
async function searchDealsInCategory(categoryId, limit = 20) {
  if (!KEEPA_API_KEY) return [];

  try {
    const res = await axios.get(`${KEEPA_BASE_URL}/query`, {
      params: {
        key:              KEEPA_API_KEY,
        domain:           DOMAIN,
        selection:        JSON.stringify({
          categories:     [categoryId],
          priceTypes:     [0],  // 0 = Amazon
          minDropCount:   3,    // dropped in price at least 3 times recently
          dateRange:      2,    // last 2 days
          sort:           [['deltaPercent', 'desc']], // biggest % drops first
          limit,
        }),
      },
      timeout: 20000,
    });

    return res.data?.asinList || [];
  } catch (err) {
    console.error(`[Amazon/Keepa] Category search failed for ${categoryId}:`, err.message);
    return [];
  }
}

// ââ Main Scrape Function ââââââââââââââââââââââââââââââââââââââ

/**
 * Scrape Amazon via Keepa for price glitches.
 * Returns array of deal objects.
 */
async function scrape(minDiscountPct = 70) {
  if (!KEEPA_API_KEY) {
    console.log('[Amazon] KEEPA_API_KEY not set â skipping Amazon scrape');
    return [];
  }

  console.log('[Amazon] Starting Keepa-powered price glitch scan...');
  const deals = [];

  for (const catId of WATCH_CATEGORIES) {
    const asins = await searchDealsInCategory(catId);
    console.log(`[Amazon] Category ${catId}: found ${asins.length} potential drops`);

    for (const asin of asins) {
      const data = await getProductPriceData(asin);
      if (!data || !data.current || !data.max90Day) continue;

      // Use 90-day high as the "normal" price baseline
      const normalPrice   = data.max90Day;
      const currentPrice  = data.current;
      const discountPct   = ((normalPrice - currentPrice) / normalPrice) * 100;

      if (discountPct >= minDiscountPct) {
        console.log(`[Amazon] ð¥ Glitch found: ${data.name} â $${currentPrice} (was $${normalPrice.toFixed(2)}, ${Math.round(discountPct)}% off)`);
        deals.push({
          productId:    `amazon_${asin}`,
          retailer:     'Amazon',
          name:         data.name,
          url:          data.url,
          imageUrl:     data.imageUrl,
          price:        currentPrice,
          normalPrice:  normalPrice,
          discountPct:  discountPct,
          source:       'Keepa/Amazon',
        });
      }

      // Keepa rate limit â brief pause between requests
      await sleep(500);
    }

    await sleep(1000);
  }

  console.log(`[Amazon] Scan complete. ${deals.length} glitch deal(s) found.`);
  return deals;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { scrape, getProductPriceData };
