// server.js — provider-agnostic market-data proxy
// Node 18+ (uses built-in fetch). Zero dependencies.
//
// Why this exists:
//   • Your API key stays on the server, never in the browser.
//   • It sets CORS headers, so the browser app can actually reach it
//     (the thing that broke direct Twelve Data calls).
//   • It normalizes Twelve Data AND Polygon into one shape, so the
//     frontend doesn't care which provider is behind it.
//
// Endpoint:
//   GET /api/timeseries?symbol=AAPL&interval=1day
//   -> { provider, symbol, interval, values: [{ datetime, open, high, low, close, volume }] }
//      (values are oldest-first, ready to chart)

import http from "node:http";
import { readFile } from "node:fs/promises";

const PORT = process.env.PORT || 8787;
const PROVIDER = (process.env.PROVIDER || "twelvedata").toLowerCase(); // "twelvedata" | "polygon"
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // lock to your app's URL in production

// Canonical intervals the frontend asks for, mapped per provider.
const INTERVALS = {
  "1day":  { td: "1day",  poly: { mult: 1,  span: "day" },    lookbackDays: 800 },
  "1week": { td: "1week", poly: { mult: 1,  span: "week" },   lookbackDays: 2200 },
  "4hour": { td: "4h",    poly: { mult: 4,  span: "hour" },   lookbackDays: 220 },
  "1hour": { td: "1h",    poly: { mult: 1,  span: "hour" },   lookbackDays: 60 },
  "30min": { td: "30min", poly: { mult: 30, span: "minute" }, lookbackDays: 30 },
};

const send = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
};

const ymd = (d) => d.toISOString().slice(0, 10);

// ---- Twelve Data adapter (free: 800/day, 8/min) ----
async function fromTwelveData(symbol, ivKey) {
  if (!TD_KEY) throw { status: 500, msg: "TWELVEDATA_API_KEY is not set on the server." };
  const iv = INTERVALS[ivKey].td;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${iv}&outputsize=400&apikey=${TD_KEY}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status === "error" || d.code) throw { status: d.code || 502, msg: d.message || "Twelve Data error." };
  if (!d.values || !d.values.length) throw { status: 404, msg: "No data for that symbol/interval." };
  return d.values
    .map((v) => ({
      datetime: v.datetime,
      open: +v.open, high: +v.high, low: +v.low, close: +v.close,
      volume: v.volume ? +v.volume : 0,
    }))
    .reverse(); // Twelve Data returns newest-first
}

// ---- Polygon adapter (free: 5/min, 15-min delayed) ----
async function fromPolygon(symbol, ivKey) {
  if (!POLY_KEY) throw { status: 500, msg: "POLYGON_API_KEY is not set on the server." };
  const cfg = INTERVALS[ivKey];
  const to = new Date();
  const from = new Date(Date.now() - cfg.lookbackDays * 86400000);
  const { mult, span } = cfg.poly;
  const intraday = span === "hour" || span === "minute";
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${mult}/${span}/${ymd(from)}/${ymd(to)}?adjusted=true&sort=asc&limit=50000&apiKey=${POLY_KEY}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok) throw { status: r.status, msg: d.error || d.message || `Polygon HTTP ${r.status}` };
  if (d.status === "ERROR" || d.error) throw { status: 502, msg: d.error || d.message || "Polygon error." };
  if (!d.results || !d.results.length) throw { status: 404, msg: "No data for that symbol/interval." };
  return d.results.map((b) => ({
    // Polygon timestamps are UTC epoch ms. Intraday times are therefore UTC, not market-local.
    datetime: new Date(b.t).toISOString().slice(0, intraday ? 16 : 10).replace("T", " "),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0,
  })); // sort=asc -> already oldest-first
}

// Small JSON GET with Polygon error handling
async function pgGet(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok) throw { status: r.status, msg: d.error || d.message || `Polygon HTTP ${r.status}` };
  if (d.status === "ERROR" || d.error) throw { status: 502, msg: d.error || d.message || "Polygon error." };
  return d;
}

// ---- Polygon: real buy/sell flow via Lee-Ready (quote-matched) classification ----
async function polygonFlow(symbol) {
  if (PROVIDER !== "polygon") throw { status: 400, msg: "Order flow requires the Polygon provider." };
  if (!POLY_KEY) throw { status: 500, msg: "POLYGON_API_KEY is not set on the server." };
  const KEY = `apiKey=${POLY_KEY}`;

  // 1) Most recent trades define the analysis window.
  const td = await pgGet(`https://api.polygon.io/v3/trades/${encodeURIComponent(symbol)}?order=desc&sort=timestamp&limit=50000&${KEY}`);
  const trades = (td.results || [])
    .map((t) => ({ p: t.price, s: t.size, t: t.sip_timestamp || t.participant_timestamp || 0 }))
    .filter((x) => x.p != null && x.s != null);
  if (!trades.length) throw { status: 404, msg: "No recent trades (market closed, or symbol has no trades)." };
  trades.reverse(); // chronological
  const startT = trades[0].t, endT = trades[trades.length - 1].t;

  // 2) NBBO quotes spanning the same window (paginated, capped).
  const BUFFER = 5_000_000_000; // 5s in ns, so the first trade has a prior quote
  const MAX_PAGES = 4;          // up to ~200k quotes
  const quotes = [];
  let qurl = `https://api.polygon.io/v3/quotes/${encodeURIComponent(symbol)}?order=asc&sort=timestamp&limit=50000&timestamp.gte=${startT - BUFFER}&timestamp.lte=${endT}&${KEY}`;
  for (let page = 0; qurl && page < MAX_PAGES; page++) {
    const qd = await pgGet(qurl);
    for (const q of (qd.results || [])) {
      const b = q.bid_price, a = q.ask_price, t = q.sip_timestamp || q.participant_timestamp || 0;
      if (b != null && a != null) quotes.push({ b, a, t });
    }
    qurl = qd.next_url ? `${qd.next_url}&${KEY}` : null;
  }

  // 3) Lee-Ready: quote rule vs midpoint; tick test only as a tie-break at the mid.
  const STALE = 2_000_000_000; // 2s — beyond this the "prevailing" quote is too old to trust
  let buy = 0, sell = 0, qClassified = 0, tickFallback = 0;
  let qi = 0, curB = null, curA = null, curT = 0, lastDir = 1, prevP = null;
  for (const tr of trades) {
    while (qi < quotes.length && quotes[qi].t <= tr.t) { curB = quotes[qi].b; curA = quotes[qi].a; curT = quotes[qi].t; qi++; }
    const fresh = curA != null && curB != null && curA > curB && (tr.t - curT) <= STALE;
    let dir;
    if (fresh) {
      const mid = (curB + curA) / 2;
      dir = tr.p > mid ? 1 : tr.p < mid ? -1 : (prevP == null ? lastDir : (tr.p > prevP ? 1 : tr.p < prevP ? -1 : lastDir));
      qClassified++;
    } else {
      dir = prevP == null ? lastDir : (tr.p > prevP ? 1 : tr.p < prevP ? -1 : lastDir); // tick fallback
      tickFallback++;
    }
    if (dir > 0) buy += tr.s; else sell += tr.s;
    lastDir = dir; prevP = tr.p;
  }
  const tot = buy + sell;
  return {
    symbol, method: "lee-ready",
    buyVol: buy, sellVol: sell, buyPct: tot ? (buy / tot) * 100 : 50,
    trades: trades.length, quotes: quotes.length,
    quoteClassifiedPct: trades.length ? (qClassified / trades.length) * 100 : 0,
    tickFallback,
    fromMs: Math.round(startT / 1e6), toMs: Math.round(endT / 1e6),
  };
}

// ---- Polygon: whole-market snapshot, filtered + sorted ----
async function polygonUniverse(sort, limit, minPrice, minVol) {
  if (PROVIDER !== "polygon") throw { status: 400, msg: "Market scan requires the Polygon provider." };
  if (!POLY_KEY) throw { status: 500, msg: "POLYGON_API_KEY is not set on the server." };
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${POLY_KEY}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok) throw { status: r.status, msg: d.error || d.message || `Polygon HTTP ${r.status}` };
  if (d.status === "ERROR" || d.error) throw { status: 502, msg: d.error || d.message || "Polygon error." };
  let rows = (d.tickers || []).map((t) => ({
    symbol: t.ticker,
    price: (t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || (t.prevDay && t.prevDay.c) || 0,
    changePct: t.todaysChangePerc != null ? t.todaysChangePerc : 0,
    volume: (t.day && t.day.v) || 0,
  })).filter((x) => x.price >= minPrice && x.volume >= minVol && /^[A-Z]+$/.test(x.symbol));
  if (sort === "losers") rows.sort((a, b) => a.changePct - b.changePct);
  else if (sort === "gainers") rows.sort((a, b) => b.changePct - a.changePct);
  else rows.sort((a, b) => b.volume - a.volume);
  return { sort, total: rows.length, tickers: rows.slice(0, limit) };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") return send(res, 204, {}); // CORS preflight

  // Serve the frontend at the root, same-origin as the API (no CORS/file:// headaches).
  if (u.pathname === "/" || u.pathname === "/index.html") {
    try {
      const html = await readFile(new URL("./quant-terminal.html", import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } catch {
      send(res, 500, { error: "quant-terminal.html not found next to server.js" });
    }
    return;
  }

  if (u.pathname === "/health") return send(res, 200, { ok: true, provider: PROVIDER });

  // ---- Real order flow: tick-rule buy/sell from recent trades (Polygon) ----
  if (u.pathname === "/api/flow") {
    const symbol = (u.searchParams.get("symbol") || "").trim().toUpperCase();
    if (!symbol) return send(res, 400, { error: "Missing ?symbol" });
    try { return send(res, 200, await polygonFlow(symbol)); }
    catch (e) { return send(res, e.status || 502, { error: e.msg || "flow request failed" }); }
  }

  // ---- Whole-market scan: filtered/sorted snapshot of all US tickers (Polygon) ----
  if (u.pathname === "/api/universe") {
    const sort = u.searchParams.get("sort") || "active";
    const limit = Math.min(100, +(u.searchParams.get("limit") || 25));
    const minPrice = +(u.searchParams.get("minPrice") || 5);
    const minVol = +(u.searchParams.get("minVol") || 1000000);
    try { return send(res, 200, await polygonUniverse(sort, limit, minPrice, minVol)); }
    catch (e) { return send(res, e.status || 502, { error: e.msg || "universe request failed" }); }
  }

  if (u.pathname !== "/api/timeseries") return send(res, 404, { error: "Not found." });

  const symbol = (u.searchParams.get("symbol") || "").trim().toUpperCase();
  const interval = u.searchParams.get("interval") || "1day";
  if (!symbol) return send(res, 400, { error: "Missing ?symbol" });
  if (!INTERVALS[interval]) {
    return send(res, 400, { error: `Unsupported interval. Use one of: ${Object.keys(INTERVALS).join(", ")}` });
  }

  try {
    const values =
      PROVIDER === "polygon"
        ? await fromPolygon(symbol, interval)
        : await fromTwelveData(symbol, interval);
    return send(res, 200, { provider: PROVIDER, symbol, interval, values });
  } catch (e) {
    const status = e && e.status ? e.status : 502;
    return send(res, status, { error: e && e.msg ? e.msg : "Upstream request failed." });
  }
});

server.listen(PORT, () => {
  console.log(`market-data proxy listening on :${PORT}  (provider: ${PROVIDER})`);
});
