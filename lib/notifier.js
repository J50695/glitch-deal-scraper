// ============================================================
//  lib/notifier.js  - Discord + Email Alerts
//  Fires the moment a price glitch is detected.
//  Discord: instant embed per deal
//  Email:   batched digest (1 email per scrape run with new deals)
// ============================================================

require('dotenv').config();
const axios      = require('axios');
const nodemailer = require('nodemailer');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const EMAIL_USER      = process.env.EMAIL_USER;
const EMAIL_PASS      = process.env.EMAIL_PASS;
const EMAIL_TO        = process.env.EMAIL_TO || EMAIL_USER;

// --- Helpers ---

function fmtPrice(n) {
  return n != null ? `$${Number(n).toFixed(2)}` : 'N/A';
}

function dealColor(deal) {
  const pct = Number(deal?.discountPct || 0);
  const score = Number(deal?.qualityScore || 0);
  const signal = String(deal?.signalLabel || '').toLowerCase();

  if (signal === 'a-tier' || score >= 85 || pct >= 90) return 0xE53935;
  if (signal === 'strong' || score >= 72 || pct >= 75) return 0x2ECC71;
  if (signal === 'watch' || score >= 58 || pct >= 55) return 0x3498DB;
  return 0x95A5A6;
}

function dealUrlForChannel(deal, channel) {
  if (deal?.trackedUrls?.[channel]) return deal.trackedUrls[channel];
  if (deal?.trackUrl) return deal.trackUrl;
  return deal?.url || '';
}

// --- Discord ---

async function sendDiscordAlert(deal) {
  if (!DISCORD_WEBHOOK) {
    console.warn('[Discord] No webhook URL set - skipping alert');
    return;
  }
  const pct   = Math.round(deal.discountPct || 0);
  const personal = deal.personalMatch;
  const color = dealColor(deal);
  const dealUrl = dealUrlForChannel(deal, 'discord');
  const embed = {
    title:       `${personal ? 'Personal deal' : (pct + '% OFF')} - ${deal.name}`.slice(0, 256),
    url:         dealUrl,
    color:       color,
    description: personal
      ? `**${deal.merchant || deal.retailer || deal.storeName}** - matches your shopping list.`
      : `**${deal.retailer || deal.storeName}** price glitch detected!`,
    fields: [
      { name: personal ? 'Current Price' : 'Glitch Price', value: fmtPrice(deal.price), inline: true },
      { name: personal ? 'Reference Price' : 'Normal Price', value: fmtPrice(deal.normalPrice || deal.originalPrice), inline: true },
      { name: 'Discount', value: pct > 0 ? `${pct}% off` : 'Reference price unavailable', inline: true },
    ],
    footer:    { text: `Glitch Deal Scraper | ${new Date().toLocaleString()}` },
    thumbnail: deal.imageUrl ? { url: deal.imageUrl } : undefined,
  };
  if (personal) {
    embed.fields.push({ name: 'Shopping List', value: personal.label, inline: true });
    embed.fields.push({ name: 'Why It Matched', value: personal.reason });
    if (personal.possiblePricingMistake) {
      embed.fields.push({ name: 'Price Signal', value: 'Possible pricing mistake / deep markdown; not checkout-verified.' });
    }
  }
  if (deal.qualityScore != null) {
    embed.fields.push({ name: 'Score', value: `${deal.qualityScore}/100`, inline: true });
  }
  if (deal.signalLabel) {
    embed.fields.push({ name: 'Signal', value: deal.signalLabel, inline: true });
  }
  if (deal.thresholdPct != null) {
    embed.fields.push({ name: 'Threshold', value: `${Math.round(deal.thresholdPct)}%`, inline: true });
  }
  if (deal.sourceLabel && deal.sourceLabel !== deal.retailer) {
    embed.fields.push({ name: 'Source', value: deal.sourceLabel, inline: true });
  }
  try {
    await axios.post(DISCORD_WEBHOOK, { username: 'Glitch Deal Bot', embeds: [embed] });
    console.log(`[Discord] Alert sent: ${deal.name} (${pct}% off)`);
  } catch (err) {
    console.error('[Discord] Failed:', err.response?.data || err.message);
  }
}

async function sendSystemAlert({
  title,
  message,
  fields = [],
  color = 0xFFAA00,
}) {
  if (!DISCORD_WEBHOOK) {
    console.warn('[Discord] No webhook URL set - skipping system alert');
    return;
  }

  const embed = {
    title,
    color,
    description: message,
    fields,
    footer: { text: `Glitch Deal Scraper | ${new Date().toLocaleString()}` },
  };

  try {
    await axios.post(DISCORD_WEBHOOK, { username: 'Glitch Deal Bot', embeds: [embed] });
    console.log(`[Discord] System alert sent: ${title}`);
  } catch (err) {
    console.error('[Discord] System alert failed:', err.response?.data || err.message);
  }
}

// --- Email ---

async function sendEmailDigest(deals) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[Email] Credentials not set - skipping digest');
    return;
  }
  if (!deals || deals.length === 0) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  const dealCards = deals.map(d => `
    <div style="border:2px solid #FF3333;border-radius:12px;padding:16px;margin:12px 0;background:#1a1a1a">
      <h3 style="margin:0 0 8px;color:#fff"><a href="${dealUrlForChannel(d, 'email')}" style="color:#FF6666;text-decoration:none">${d.name}</a></h3>
      <p>${d.personalMatch ? 'Price' : 'Glitch'}: <b style="color:#FF3333">${fmtPrice(d.price)}</b> | Reference: <span style="text-decoration:line-through;color:#999">${fmtPrice(d.normalPrice || d.originalPrice)}</span></p>
      ${d.personalMatch ? `<p>${d.personalMatch.label}: ${d.personalMatch.reason}</p>` : ''}
      <p style="color:#999;margin:6px 0 10px">Score: <b style="color:#fff">${d.qualityScore ?? 'n/a'}</b>${d.signalLabel ? ` | Signal: <b style="color:#fff">${d.signalLabel}</b>` : ''}</p>
      <a href="${dealUrlForChannel(d, 'email')}" style="display:inline-block;padding:8px 20px;background:#FF3333;color:#fff;border-radius:6px;text-decoration:none">BUY NOW</a>
    </div>`).join('');
  const personalDigest = deals.some((deal) => deal.personalMatch);
  const html = `<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;padding:20px;max-width:600px;margin:auto"><h1 style="color:#FF3333">${personalDigest ? 'Your Shopping Deals' : 'Glitch Deals Alert'}</h1><p>${deals.length} deal${deals.length > 1 ? 's' : ''} found!</p>${dealCards}<p style="color:#666;font-size:12px">Glitch Deal Scraper | ${new Date().toLocaleString()}</p></body></html>`;
  try {
    await transporter.sendMail({
      from:    `Glitch Deal Bot <${EMAIL_USER}>`,
      to:      EMAIL_TO,
      subject: personalDigest ? `${deals.length} personal shopping deal(s)` : `${deals.length} GLITCH DEAL${deals.length > 1 ? 'S' : ''} - Act Fast!`,
      html,
    });
    console.log(`[Email] Digest sent: ${deals.length} deals`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

module.exports = { sendDiscordAlert, sendSystemAlert, sendEmailDigest };
