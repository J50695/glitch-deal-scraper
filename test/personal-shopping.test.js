const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadShoppingConfig, matchPersonalDeal, evaluatePersonalDeal } = require('../lib/personal-shopping');
const { parseSlickdealsHtml } = require('../lib/slickdeals-data');

const config = loadShoppingConfig({});
const deal = (name, values = {}) => ({ name, retailer: 'Best Buy', price: 500, discountPct: 20, ...values });
const matchingIds = (item, settings = config) => matchPersonalDeal(item, settings).map((rule) => rule.id);

test('PS5 Pro accepts the console with a modest discount, not PS5 Slim, accessories or games', () => {
  for (const name of ['Sony - PlayStation 5 Pro Console - 2TB', 'PS5 Pro', 'Open-box Sony PS5 Pro 2TB']) {
    const item = deal(name);
    const matches = matchPersonalDeal(item, config);
    assert.deepEqual(matches.map((rule) => rule.id), ['ps5-pro']);
    assert.equal(evaluatePersonalDeal(item, matches).label, 'PS5 Pro console');
  }
  for (const name of ['Sony PS5 Slim Console', 'PS5 Pro controller', 'Stand for PS5 Pro', 'PS5 Pro Enhanced GTA VI', 'GTA VI (PS5 Pro)', 'PS5 Pro empty box', 'PS5 Pro for parts']) {
    assert.deepEqual(matchingIds(deal(name)), [], name);
  }
});

test('personal categories reject common false matches and unrelated items', () => {
  assert.ok(matchingIds(deal('Nike Air Max 90 sneakers')).includes('nike-shoes'));
  assert.ok(matchingIds(deal('Air Jordan 4 Retro shoes')).includes('nike-shoes'));
  assert.ok(matchingIds(deal('Prada cotton shirt')).includes('designer'));
  assert.ok(matchingIds(deal('Samsung 65-inch OLED 4K Smart TV')).includes('tvs'));
  assert.ok(matchingIds(deal('Levis 501 jeans')).includes('clothes'));
  for (const name of ['Nike shoe cleaner', 'Samsung 65 inch TV wall mount', 'Amazon Fire TV Stick 4K', 'Apple TV 4K', 'TV stand console', 'Google TV projector', 'TCL sound bar for Smart TV', 'Lenovo monitor', 'USB charger']) {
    assert.deepEqual(matchingIds(deal(name)), [], name);
  }
  assert.deepEqual(matchingIds(deal('Nike Dunk Low shoes', { retailer: 'OfferUp', priceBasis: 'estimated_resale' })), []);
});

test('a configured target price is a ceiling and does not require a discount baseline', () => {
  const settings = structuredClone(config);
  settings.rules.find((rule) => rule.id === 'ps5-pro').maxPrice = 450;
  const low = deal('PS5 Pro', { price: 440, discountPct: 0 });
  assert.match(evaluatePersonalDeal(low, matchPersonalDeal(low, settings)).reason, /450\.00 target/);
  const high = deal('PS5 Pro', { price: 460, discountPct: 80 });
  assert.equal(evaluatePersonalDeal(high, matchPersonalDeal(high, settings)), null);
  assert.equal(evaluatePersonalDeal(deal('PS5 Pro', { price: -1 }), matchPersonalDeal(low, settings)), null);
});

test('size and screen requirements need observed matching data', () => {
  const settings = structuredClone(config);
  settings.rules = [settings.rules.find((rule) => rule.id === 'nike-shoes')];
  settings.rules[0].sizes = ['10.5'];
  const shoes = deal('Nike Dunk Low shoes');
  assert.deepEqual(matchingIds(shoes, settings), []);
  assert.deepEqual(matchingIds({ ...shoes, availableSizes: ['9', '10.5'] }, settings), ['nike-shoes']);
  const tvSettings = structuredClone(config);
  tvSettings.rules.find((rule) => rule.id === 'tvs').minScreenInches = 65;
  assert.deepEqual(matchingIds(deal('Samsung 55-inch TV'), tvSettings), []);
  assert.deepEqual(matchingIds(deal('Samsung 65-inch TV'), tvSettings), ['tvs']);
  assert.deepEqual(matchingIds(deal('Samsung Smart TV'), tvSettings), []);
});

test('all mode bypasses personal matching; expired and sold items never match', () => {
  assert.equal(loadShoppingConfig({ SHOPPING_MODE: 'all' }).mode, 'all');
  assert.throws(() => loadShoppingConfig({ SHOPPING_MODE: 'oops' }), /SHOPPING_MODE/);
  assert.deepEqual(matchingIds(deal('PS5 Pro'), { ...config, mode: 'all' }), []);
  for (const field of ['expired', 'soldOut']) assert.deepEqual(matchingIds(deal('PS5 Pro', { [field]: true })), []);
});

test('Slickdeals data excludes expired/old posts, handles rounding and keeps distinct products', () => {
  const table = [];
  const append = (value) => { table.push(value); return table.length - 1; };
  const addRow = (title, slug, expired, date) => append(Object.fromEntries(Object.entries({
    dealTitle: title, dealThreadUrl: '/f/' + slug, finalPriceText: '$500', listPriceText: '$600',
    storeName: 'Best Buy', isExpired: expired, threadIsoDatetime: date,
  }).map(([key, value]) => [key, append(value)])));
  addRow('PS5 Pro console $499.99', '123-ps5', false, '2026-11-06T10:00:00Z');
  addRow('Nike shoes', '456-shoes', false, '2026-11-06T10:00:00Z');
  addRow('PS5 Pro expired', '789-expired', true, '2026-11-06T10:00:00Z');
  addRow('PS5 Pro old', '101-old', false, '2026-04-01T10:00:00Z');
  const html = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(table)}</script>`;
  const items = parseSlickdealsHtml(html, { now: Date.parse('2026-11-06T12:00:00Z') });
  assert.equal(items.length, 2);
  assert.equal(items[0].price, 499.99);
  assert.equal(items[0].merchant, 'Best Buy');
  assert.notEqual(items[0].productId, items[1].productId);
  assert.equal(parseSlickdealsHtml('<html>blocked</html>'), null);
});
