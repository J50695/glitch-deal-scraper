// ============================================================
//  scrapers/lenovo.js - Lenovo Deals API Scraper
// ============================================================

const axios = require('axios');
const { sleep } = require('./playwright-base');

const LENOVO_PAGE_ORIGIN = 'https://www.lenovo.com/us/en';
const LENOVO_ASSET_ORIGIN = 'https://www.lenovo.com';
const LENOVO_API_URL = 'https://openapi.lenovo.com/us/en/ofp/search/dlp/product/query/get/_tsc';

const LENOVO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.lenovo.com/us/en/d/deals/',
};

const LENOVO_TARGETS = [
  {
    label: 'Lenovo Laptops',
    pageFilterId: '46b8a823-06f3-43ff-aea9-b8620033655f',
    classificationGroupIds: '400001',
    sorts: ['bestSelling'],
    pageSize: 24,
    maxPages: 2,
  },
  {
    label: 'Lenovo Monitors',
    pageFilterId: '4d06041b-4be1-49e6-bcc5-0fc099ac1b7d',
    classificationGroupIds: '400001',
    sorts: ['Recommended', 'priceUp'],
    pageSize: 24,
    maxPages: 2,
  },
  {
    label: 'Lenovo Gaming',
    pageFilterId: '8b02314e-71d9-4757-8565-53b1061d6d02',
    classificationGroupIds: '400001',
    sorts: ['bestSelling'],
    pageSize: 24,
    maxPages: 2,
  },
  {
    label: 'Lenovo Workstations',
    pageFilterId: 'cd704b88-bdd3-4f52-a55f-936e3a723d53',
    classificationGroupIds: '400001',
    sorts: ['priceUp'],
    pageSize: 24,
    maxPages: 2,
  },
];

function toNumber(value) {
  if (value == null) return null;
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function absolutePageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return `${LENOVO_PAGE_ORIGIN}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function absoluteAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return `${LENOVO_ASSET_ORIGIN}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function buildQueryUrl(target, page) {
  const payload = {
    classificationGroupIds: target.classificationGroupIds,
    pageFilterId: target.pageFilterId,
    facets: [],
    page: String(page),
    pageSize: target.pageSize,
    groupCode: '',
    init: true,
    sorts: target.sorts,
    version: 'v2',
    enablePreselect: true,
    subseriesCode: '',
  };

  const query = new URLSearchParams({
    pageFilterId: target.pageFilterId,
    subSeriesCode: '',
    loyalty: 'false',
    params: encodeURIComponent(JSON.stringify(payload)),
  });

  return `${LENOVO_API_URL}?${query.toString()}`;
}

function flattenProducts(apiResponse) {
  const groups = apiResponse?.data?.data;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => Array.isArray(group?.products) ? group.products : []);
}

function isProductAvailable(product) {
  if (product?.purchaseFlag === false) return false;
  const marketingStatus = String(product?.marketingStatus || '').toLowerCase();
  return !(
    marketingStatus.includes('oos') ||
    marketingStatus.includes('expired') ||
    marketingStatus.includes('temporarily unavailable') ||
    marketingStatus.includes('end of life')
  );
}

function buildDeal(product, target) {
  const code = String(product?.productCode || product?.virtualProductCode || '').trim();
  const name = String(product?.summary || product?.cardSummary || product?.productName || '').replace(/\s+/g, ' ').trim();
  const url = absolutePageUrl(product?.url);
  const imageUrl = absoluteAssetUrl(
    product?.media?.thumbnail?.imageAddress ||
    product?.media?.listImage?.[0]?.imageAddress ||
    product?.media?.heroImage?.imageAddress
  ) || null;

  const price = toNumber(product?.finalPrice || product?.instantSavingPrice || product?.lowestPrice || product?.tipPrice);
  let normalPrice = toNumber(product?.webPrice || product?.beforeTaxPrice);
  const saveAmount = toNumber(product?.saveAmount || product?.instantSavingSaveAmount);
  const declaredPercent = toNumber(product?.savePercent || product?.instantSavingSavePercentage);

  if (!code || !name || !url || !price) return null;
  if (!(normalPrice > price) && saveAmount) {
    normalPrice = price + saveAmount;
  }

  let discountPct = 0;
  if (normalPrice > price) {
    discountPct = ((normalPrice - price) / normalPrice) * 100;
  } else if (declaredPercent) {
    discountPct = declaredPercent;
  } else {
    return null;
  }

  return {
    productId: `lenovo_${code}`,
    retailer: 'Lenovo',
    name,
    url,
    imageUrl,
    price,
    normalPrice: normalPrice || null,
    discountPct,
    source: target.label,
  };
}

async function fetchTargetProducts(target, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  const products = [];
  let pageCount = 1;

  for (let page = 1; page <= Math.min(target.maxPages, pageCount); page += 1) {
    if (isAborted()) break;

    const url = buildQueryUrl(target, page);
    const response = await axios.get(url, {
      headers: LENOVO_HEADERS,
      timeout: 20000,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    pageCount = toPositiveInt(response?.data?.data?.pageCount, 1);
    const batch = flattenProducts(response?.data);

    console.log(`[Lenovo] ${target.label} page ${page}: ${batch.length} product(s)`);
    if (!batch.length) break;

    products.push(...batch);

    if (page < Math.min(target.maxPages, pageCount)) {
      await sleep(500);
    }
  }

  return products;
}

async function scrape(minDiscountPct = 40, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[Lenovo] Starting scrape...');

  const deals = [];
  const seen = new Set();

  for (const target of LENOVO_TARGETS) {
    if (isAborted()) {
      console.warn('[Lenovo] Aborted before starting ' + target.label);
      break;
    }

    try {
      const products = await fetchTargetProducts(target, { isAborted });
      let qualifying = 0;

      for (const product of products) {
        if (isAborted()) {
          console.warn('[Lenovo] Aborted during ' + target.label);
          break;
        }
        if (!isProductAvailable(product)) continue;

        const deal = buildDeal(product, target);
        if (!deal || seen.has(deal.productId)) continue;
        seen.add(deal.productId);

        if (deal.discountPct >= minDiscountPct) {
          deals.push(deal);
          qualifying += 1;
        }
      }

      console.log(`[Lenovo] ${target.label}: ${qualifying} qualifying deal(s)`);
    } catch (err) {
      const status = err?.response?.status ? `HTTP ${err.response.status}` : err.message;
      console.error('[Lenovo] Error on ' + target.label + ':', status);
    }

    if (isAborted()) break;
    await sleep(750);
  }

  console.log('[Lenovo] Done. ' + deals.length + ' deal(s).');
  return deals;
}

module.exports = { scrape };
