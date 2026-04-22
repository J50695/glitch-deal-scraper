# Glitch Deal Scraper — Setup Guide

Monitors Amazon, Best Buy, Walmart, Nike, Adidas, and Target every 10 minutes, 24/7
for price glitches — items priced 70%+ below normal. Fires instant Discord alerts.

---

## What You Need

- A server to run it 24/7 (Railway recommended — free tier works)
- Discord server where you want alerts sent
- (Optional) Keepa API key for Amazon price history
- (Optional) Gmail app password for email digests

---

## Step 1 — Deploy to Railway (Recommended)

1. Go to railway.app and create a free account
2. Click New Project -> Deploy from GitHub
3. Push this folder to a GitHub repo first
4. Railway will auto-detect Node.js and run npm start
5. After first deploy, go to Variables tab and add your env vars

## Step 2 — Set Up Discord Alerts (Required)

1. Open Discord and go to your server
2. Create a new channel (e.g. #glitch-deals)
3. Click gear icon -> Integrations -> Webhooks
4. Click New Webhook -> Copy Webhook URL
5. Paste as DISCORD_WEBHOOK_URL in .env or Railway Variables

## Step 3 — Environment Variables

| Variable | Required | Description |
|---|---|---|
| DISCORD_WEBHOOK_URL | Yes | Your Discord webhook URL |
| KEEPA_API_KEY | Recommended | Amazon scanning. Free at keepa.com/#!api |
| EMAIL_USER | Optional | Gmail address for email digests |
| EMAIL_PASS | Optional | Gmail App Password |
| EMAIL_TO | Optional | Where to send the digest |
| MIN_DISCOUNT_PCT | Optional | Min % drop to alert (default: 70) |
| SCRAPE_INTERVAL_MINUTES | Optional | How often to scan (default: 10) |

## Step 4 — Verify It's Working

Once running, open: http://localhost:3000
The first scan starts 15 seconds after launch. After that, every 10 minutes.

## The Flip Strategy

| Category | Best Platform | Notes |
|---|---|---|
| Sneakers | StockX, GOAT | Fastest liquidity, fixed fees |
| Electronics | eBay, Facebook Marketplace | Photos matter |
| Apparel | Depop, eBay | Depop for hype items |
| General | OfferUp, FB Marketplace | Local = no shipping hassle |

Risk management: Some retailers can cancel orders on obvious pricing errors. Move fast.
