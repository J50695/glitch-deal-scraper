const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

async function runPipeline({ mode = 'personal', cap = null } = {}) {
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
  const sent = [], recorded = [], routes = {}, errors = [], floors = [];
  let nextId = 0;
  const db = {
    recordScraperRun() {}, getLatestAlertForProduct() { return null; },
    savePrice() { return { productDbId: ++nextId, avgPrice: null, dataPoints: 1 }; },
    recordAlert(item) { assert.ok(item.normalPrice > 0); recorded.push(item); return recorded.length; },
  };
  const app = {
    use() {}, get(route, handler) { routes[route] = handler; }, post() {}, listen(port, callback) { callback(); },
  };
  const express = Object.assign(() => app, { json: () => () => {}, static: () => () => {} });
  const shopper = require('../lib/personal-shopping');
  const sandbox = {
    __dirname: root, console: { log() {}, warn() {}, error(...args) { errors.push(args.join(' ')); } },
    process: { env: {}, on() {} },
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
      if (name.startsWith('./scrapers/')) return { async scrape(floor) { floors.push(floor); return name.endsWith('/bestbuy') ? data : []; } };
      throw new Error('Unexpected import: ' + name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), sandbox);
  await vm.runInContext('runScraper()', sandbox);
  assert.deepEqual(errors, []);
  return { sent, recorded, floors, routes };
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
