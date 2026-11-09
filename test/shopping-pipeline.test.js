const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

async function runPipeline({ mode = 'personal', cap = null, sources = null, repeatedIds = [], minAlertScore = '0' } = {}) {
  const config = structuredClone(require('../shopping-list.json'));
  config.mode = mode;
  config.rules.find((rule) => rule.id === 'ps5-pro').maxPrice = cap;
  const data = [
    { name: 'Sony PS5 Pro console', price: 500, normalPrice: 600, discountPct: 100 / 6 },
    { name: 'Sony PS5 Slim console', price: 100, normalPrice: 500, discountPct: 80 },
    { name: 'Sony PS5 Pro controller', price: 20, normalPrice: 100, discountPct: 80 },
    { name: 'Nike Air Max shoes', price: 40, normalPrice: 100, discountPct: 60 },
    { name: 'Samsung 65-inch TV', price: 400, normalPrice: 700, discountPct: 300 / 7 },
  ].map((item, i) => ({ ...item, productId: 'item' + i, url: 'https://shop.example/' + i, retailer: 'Best Buy' }));
  if (cap) data.push({ name: 'PS5 Pro', price: 425, discountPct: 0, productId: 'price-only', url: 'https://shop.example/target', retailer: 'Best Buy' });
  const sent = [], recorded = [], routes = {}, errors = [], floors = [], runRecords = [];
  const savedProducts = new Map();
  let nextId = 0;
  const db = {
    recordScraperRun(record) { runRecords.push(record); },
    getLatestAlertForProduct(id) {
      const product = savedProducts.get(id);
      return repeatedIds.includes(product?.productId) ? { alerted_at: new Date().toISOString(), glitch_price: product.price } : null;
    },
    savePrice(product) { savedProducts.set(++nextId, product); return { productDbId: nextId, avgPrice: null, dataPoints: 1 }; },
    recordAlert(item) { assert.ok(item.normalPrice > 0); recorded.push(item); return recorded.length; },
  };
  const app = {
    use() {}, get(route, handler) { routes[route] = handler; }, post() {}, listen(port, callback) { callback(); },
  };
  const express = Object.assign(() => app, { json: () => () => {}, static: () => () => {} });
  const shopper = require('../lib/personal-shopping');
  const sandbox = {
    __dirname: root, console: { log() {}, warn() {}, error(...args) { errors.push(args.join(' ')); } },
    process: { env: { MIN_ALERT_SCORE: minAlertScore }, on() {} },
    setTimeout(callback, ms) { if (ms === 400) callback(); return { unref() {} }; }, clearTimeout() {},
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'express') return express;
      if (name === 'cors') return () => () => {};
      if (name === 'node-cron') return { schedule() {} };
      if (name === 'path') return path;
      if (name === './lib/db') return db;
      if (name === './lib/notifier') return { async sendDiscordAlert(item) { sent.push(item); }, async sendEmailDigest() {}, async sendSystemAlert() {} };
      if (name === './lib/personal-shopping') return { ...shopper, loadShoppingConfig: () => config };
      if (name === './lib/product-id') return require('../lib/product-id');
      if (name === './scrapers/playwright-base') return { async closeBrowser() {} };
      if (name.startsWith('./scrapers/')) return { async scrape(floor) {
        floors.push(floor);
        return sources ? sources[name.split('/').pop()] || [] : name.endsWith('/bestbuy') ? data : [];
      } };
      throw new Error('Unexpected import: ' + name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), sandbox);
  await vm.runInContext('runScraper()', sandbox);
  assert.deepEqual(errors, []);
  return { sent, recorded, floors, routes, runRecords };
}

test('personal pipeline lowers collection floor and delivers only qualifying interests', async () => {
  const { sent, floors } = await runPipeline();
  assert.ok(floors.every((floor) => floor === 0));
  assert.equal(sent.length, 3);
  assert.equal(sent[0].personalMatch.ruleId, 'ps5-pro');
  assert.ok(sent.every((item) => item.personalMatch && item.trackedUrls.discord));
  assert.ok(!sent.some((item) => /Slim|controller/.test(item.name)));
});

test('price-only target passes without inventing a discount', async () => {
  const { sent } = await runPipeline({ cap: 450 });
  const target = sent.find((item) => item.productId === 'price-only');
  assert.ok(target);
  assert.equal(target.normalPrice, null);
  assert.equal(target.discountPct, 0);
  assert.ok(!sent.some((item) => item.price === 500));
});

test('all mode retains the existing retailer discount policy', async () => {
  const { sent, floors } = await runPipeline({ mode: 'all' });
  assert.ok(floors.every((floor) => floor > 0));
  assert.ok(!sent.some((item) => item.name === 'Sony PS5 Pro console'));
  assert.ok(sent.every((item) => !item.personalMatch));
});

const consoleDeal = (id, price, discountPct = 0) => ({
  name: 'PS5 Pro console', productId: id, price, discountPct,
  normalPrice: discountPct ? price / (1 - discountPct / 100) : null,
  retailer: 'Best Buy', url: 'https://shop.example/' + id,
});

test('cheapest matches are selected across scrapers before alerts are recorded', async () => {
  const { sent, recorded, runRecords } = await runPipeline({
    sources: {
      bestbuy: [consoleDeal('expensive', 700, 80), consoleDeal('third', 450)],
      slickdeals: [consoleDeal('first', 300), consoleDeal('second', 350)],
    },
    minAlertScore: '100',
  });
  assert.deepEqual(sent.map((item) => item.price), [300, 350, 450]);
  assert.equal(recorded.length, 3);
  assert.ok(!recorded.some((item) => item.glitchPrice === 700));
  assert.equal(runRecords.find((item) => item.scraperName === 'Best Buy').alerted, 1);
  assert.equal(runRecords.find((item) => item.scraperName === 'Slickdeals').alerted, 2);
});

test('cooldowns do not promote more expensive alternatives', async () => {
  const { sent, recorded } = await runPipeline({
    sources: { bestbuy: [consoleDeal('first', 300), consoleDeal('second', 350), consoleDeal('third', 450), consoleDeal('fourth', 700)] },
    repeatedIds: ['first', 'second', 'third'],
  });
  assert.equal(sent.length, 0);
  assert.equal(recorded.length, 0);
});

test('retailer scrapers collect price-only items at zero floor and keep positive discount floors', async () => {
  for (const name of ['sixpm', 'nordstromrack', 'newegg', 'bhphoto']) {
    const sandbox = {
      module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
      require(id) {
        if (id === '../lib/product-id') return require('../lib/product-id');
        if (id === 'axios') return { async get() { return { status: 200, data: '<title>Catalog</title>' }; } };
        if (id === './playwright-base') return {
          async newPage() { return {
            async waitForSelector() {},
            async evaluate() { return [{ name: 'Nike shoes', priceStr: '$25.00', wasStr: null, url: 'https://shop.example/shoe' }]; },
            async $$eval() { return [{ name: 'Nike shoes', priceStr: '$25.00', wasStr: null, url: 'https://shop.example/shoe' }]; },
            context() { return { async close() {} }; },
          }; },
          async goto() {}, async sleep() {}, parsePrice(value) { return value ? Number(value.replace(/[^\d.]/g, '')) : null; },
        };
        throw new Error('Unexpected import: ' + id);
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'scrapers', name + '.js'), 'utf8'), sandbox);
    const items = await sandbox.module.exports.scrape(0);
    assert.ok(items.length > 0, name);
    assert.ok(items.every((item) => item.discountPct === 0 && item.normalPrice === null), name);
    assert.equal((await sandbox.module.exports.scrape(10)).length, 0, name);
  }
});

test('Discord payload describes personal matches without claiming a verified glitch', async () => {
  const posted = [];
  const sandbox = {
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    process: { env: { DISCORD_WEBHOOK_URL: 'https://example.invalid/test' } },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'axios') return { async post(url, payload) { posted.push(payload); } };
      if (name === 'nodemailer') return {};
      throw new Error(name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'lib/notifier.js'), 'utf8'), sandbox);
  await sandbox.module.exports.sendDiscordAlert({
    name: 'PS5 Pro', retailer: 'Best Buy', price: 425, discountPct: 0,
    url: 'https://shop.example/ps5', personalMatch: { label: 'PS5 Pro console', reason: 'Below your target', possiblePricingMistake: false },
  });
  const embed = posted[0].embeds[0];
  assert.match(embed.title, /Personal deal/);
  assert.ok(!embed.description.includes('glitch detected'));
  assert.ok(embed.fields.some((field) => field.name === 'Why It Matched' && field.value === 'Below your target'));
  assert.ok(embed.fields.some((field) => field.name === 'Discount' && field.value.includes('unavailable')));
});
