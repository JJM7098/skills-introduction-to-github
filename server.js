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

// --- Index membership (Dow/NDX bundled; S&P 500 fetched live with fallback) ---
const DOW30 = "AAPL AMGN AMZN AXP BA CAT CRM CSCO CVX DIS GS HD HON IBM JNJ JPM KO MCD MMM MRK MSFT NKE NVDA PG SHW TRV UNH V VZ WMT".split(/\s+/);
const NDX100 = "AAPL MSFT NVDA AMZN AVGO META GOOGL GOOG TSLA COST NFLX AMD PEP ADBE CSCO TMUS LIN INTC INTU QCOM TXN AMAT AMGN ISRG BKNG HON VRTX ADP ADI REGN PANW GILD MU LRCX SBUX MDLZ KLAC SNPS CDNS MELI CRWD MAR CTAS ORLY ASML ABNB CSX MRVL FTNT NXPI PCAR ROP MNST ADSK WDAY CPRT PAYX KDP ROST DXCM AEP FANG FAST EXC CCEP KHC IDXX VRSK BKR ON GEHC TTD CDW DDOG TEAM ZS ANSS WBD GFS MDB ARM SMCI DASH TTWO BIIB LULU CEG XEL CSGP ODFL DLTR WBA SIRI ILMN".split(/\s+/);
const SP500_FALLBACK = "AAPL MSFT NVDA AMZN GOOGL GOOG META AVGO TSLA LLY JPM V WMT MA UNH XOM ORCL COST HD PG JNJ NFLX BAC ABBV CRM CVX KO MRK AMD PEP TMO LIN ADBE WFC CSCO ACN MCD ABT GE DHR IBM NOW TXN QCOM PM INTU CAT GS ISRG VZ DIS T BKNG AXP RTX SPGI AMGN PFE NEE UBER LOW HON UNP ETN BA C BLK PGR TJX SYK LMT BSX COP ADP MDT VRTX GILD MU MMC CB PLD ADI AMAT SBUX DE PANW SCHW BX KKR MO ELV CI SO REGN ZTS DUK BMY APH ICE WM CME SHW MCK TT KLAC CDNS GD EOG NKE EQIX SNPS CL ITW MSI PH AON MDLZ CMG USB PYPL APD EMR MAR FCX NXPI ORLY".split(/\s+/);
let SP500_CACHE = null;


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

// Heuristic participant tag from a single trade's price + size. This is an
// ESTIMATE inferred from trade fingerprints — public feeds carry no counterparty id.
function classifyParticipant(price, size) {
  const cents = price * 100;
  const subPenny = Math.abs(cents - Math.round(cents)) > 1e-6; // wholesaler price-improvement tell
  if (size >= 10000) return "inst";   // block
  if (subPenny) return "retail";      // sub-penny internalized print
  if (size < 100) return "retail";    // odd lot
  if (size >= 5000) return "inst";    // large round lot
  return "mid";                       // 100–4999 round lots: genuinely ambiguous
}

// Accumulate buy/sell volume split by participant estimate.
function newPart() { return { instBuy: 0, instSell: 0, retBuy: 0, retSell: 0, midBuy: 0, midSell: 0 }; }
function addPart(P, price, size, dir) {
  const cls = classifyParticipant(price, size);
  const b = dir > 0;
  if (cls === "inst") { if (b) P.instBuy += size; else P.instSell += size; }
  else if (cls === "retail") { if (b) P.retBuy += size; else P.retSell += size; }
  else { if (b) P.midBuy += size; else P.midSell += size; }
}
function finishPart(P, tot) {
  const instVol = P.instBuy + P.instSell, retVol = P.retBuy + P.retSell, midVol = P.midBuy + P.midSell;
  return {
    instPct: tot ? (instVol / tot) * 100 : 0,
    retailPct: tot ? (retVol / tot) * 100 : 0,
    midPct: tot ? (midVol / tot) * 100 : 0,
    instBuyPct: instVol ? (P.instBuy / instVol) * 100 : 50,
    retailBuyPct: retVol ? (P.retBuy / retVol) * 100 : 50,
  };
}

// ---- Polygon: real buy/sell flow. Uses quote-matched (Lee-Ready) when the
//      tier includes NBBO quotes; auto-falls back to the tick rule otherwise. ----
async function polygonFlow(symbol) {
  if (PROVIDER !== "polygon") throw { status: 400, msg: "Order flow requires the Polygon provider." };
  if (!POLY_KEY) throw { status: 500, msg: "POLYGON_API_KEY is not set on the server." };
  const KEY = `apiKey=${POLY_KEY}`;

  // 1) Recent trades (needed by both methods).
  let td;
  try {
    td = await pgGet(`https://api.polygon.io/v3/trades/${encodeURIComponent(symbol)}?order=desc&sort=timestamp&limit=50000&${KEY}`);
  } catch (e) {
    throw { status: e.status || 502, msg: `Trade data unavailable (${e.msg}). Order flow needs a Polygon tier that includes trades.` };
  }
  const trades = (td.results || [])
    .map((t) => ({ p: t.price, s: t.size, t: t.sip_timestamp || t.participant_timestamp || 0 }))
    .filter((x) => x.p != null && x.s != null);
  if (!trades.length) throw { status: 404, msg: "No recent trades (market closed, or symbol has no trades)." };
  trades.reverse(); // chronological
  const startT = trades[0].t, endT = trades[trades.length - 1].t;

  // 2) Try NBBO quotes for Lee-Ready. If not entitled, we fall back to the tick rule.
  const BUFFER = 5_000_000_000, MAX_PAGES = 4;
  const quotes = [];
  let quotesOk = true;
  try {
    let qurl = `https://api.polygon.io/v3/quotes/${encodeURIComponent(symbol)}?order=asc&sort=timestamp&limit=50000&timestamp.gte=${startT - BUFFER}&timestamp.lte=${endT}&${KEY}`;
    for (let page = 0; qurl && page < MAX_PAGES; page++) {
      const qd = await pgGet(qurl);
      for (const q of (qd.results || [])) {
        const b = q.bid_price, a = q.ask_price, t = q.sip_timestamp || q.participant_timestamp || 0;
        if (b != null && a != null) quotes.push({ b, a, t });
      }
      qurl = qd.next_url ? `${qd.next_url}&${KEY}` : null;
    }
  } catch { quotesOk = false; } // tier likely lacks quotes -> tick-rule fallback

  // 3a) Lee-Ready (quote rule vs midpoint, tick test as tie-break)
  if (quotesOk && quotes.length) {
    const STALE = 2_000_000_000;
    let buy = 0, sell = 0, qClassified = 0, tickFallback = 0;
    let qi = 0, curB = null, curA = null, curT = 0, lastDir = 1, prevP = null;
    const P = newPart();
    for (const tr of trades) {
      while (qi < quotes.length && quotes[qi].t <= tr.t) { curB = quotes[qi].b; curA = quotes[qi].a; curT = quotes[qi].t; qi++; }
      const fresh = curA != null && curB != null && curA > curB && (tr.t - curT) <= STALE;
      let dir;
      if (fresh) {
        const mid = (curB + curA) / 2;
        dir = tr.p > mid ? 1 : tr.p < mid ? -1 : (prevP == null ? lastDir : (tr.p > prevP ? 1 : tr.p < prevP ? -1 : lastDir));
        qClassified++;
      } else {
        dir = prevP == null ? lastDir : (tr.p > prevP ? 1 : tr.p < prevP ? -1 : lastDir);
        tickFallback++;
      }
      if (dir > 0) buy += tr.s; else sell += tr.s;
      addPart(P, tr.p, tr.s, dir);
      lastDir = dir; prevP = tr.p;
    }
    const tot = buy + sell;
    return {
      symbol, method: "lee-ready",
      buyVol: buy, sellVol: sell, buyPct: tot ? (buy / tot) * 100 : 50,
      trades: trades.length, quotes: quotes.length,
      quoteClassifiedPct: trades.length ? (qClassified / trades.length) * 100 : 0,
      tickFallback, fromMs: Math.round(startT / 1e6), toMs: Math.round(endT / 1e6),
      participant: finishPart(P, tot),
    };
  }

  // 3b) Tick rule (trades only) — works without the quotes feed
  let buy = 0, sell = 0, lastDir = 1, prev = null;
  const P = newPart();
  for (const tr of trades) {
    const dir = prev == null ? lastDir : (tr.p > prev ? 1 : tr.p < prev ? -1 : lastDir);
    if (dir > 0) buy += tr.s; else sell += tr.s;
    addPart(P, tr.p, tr.s, dir);
    lastDir = dir; prev = tr.p;
  }
  const tot = buy + sell;
  return {
    symbol, method: "tick-rule",
    buyVol: buy, sellVol: sell, buyPct: tot ? (buy / tot) * 100 : 50,
    trades: trades.length, fromMs: Math.round(startT / 1e6), toMs: Math.round(endT / 1e6),
    participant: finishPart(P, tot),
  };
}

// ---- Polygon: whole-market snapshot rows (shared by universe + index scan) ----
async function fetchSnapshotRows() {
  if (PROVIDER !== "polygon") throw { status: 400, msg: "Market data requires the Polygon provider." };
  if (!POLY_KEY) throw { status: 500, msg: "POLYGON_API_KEY is not set on the server." };
  const d = await pgGet(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${POLY_KEY}`);
  return (d.tickers || []).map((t) => ({
    symbol: t.ticker,
    price: (t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || (t.prevDay && t.prevDay.c) || 0,
    changePct: t.todaysChangePerc != null ? t.todaysChangePerc : 0,
    volume: (t.day && t.day.v) || 0,
  }));
}

async function polygonUniverse(sort, limit, minPrice, minVol) {
  let rows = (await fetchSnapshotRows()).filter((x) => x.price >= minPrice && x.volume >= minVol && /^[A-Z]+$/.test(x.symbol));
  if (sort === "losers") rows.sort((a, b) => a.changePct - b.changePct);
  else if (sort === "gainers") rows.sort((a, b) => b.changePct - a.changePct);
  else rows.sort((a, b) => b.volume - a.volume);
  return { sort, total: rows.length, tickers: rows.slice(0, limit) };
}

// Live S&P 500 constituents (public dataset) with a large-cap fallback.
async function getSP500() {
  if (SP500_CACHE) return SP500_CACHE;
  try {
    const r = await fetch("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv");
    if (r.ok) {
      const txt = await r.text();
      const syms = txt.split(/\r?\n/).slice(1)
        .map((l) => (l.split(",")[0] || "").trim().toUpperCase())
        .filter((s) => /^[A-Z.\-]{1,6}$/.test(s));
      if (syms.length >= 100) { SP500_CACHE = syms; return syms; }
    }
  } catch { /* fall through to fallback */ }
  SP500_CACHE = SP500_FALLBACK;
  return SP500_FALLBACK;
}

// ---- Polygon: narrow an index to its best pullback candidates ----
async function polygonIndexScan(index, sort, limit, minPrice, minVol) {
  let members;
  if (index === "dow") members = DOW30;
  else if (index === "ndx") members = NDX100;
  else members = await getSP500(); // sp500 default
  const set = new Set(members.map((s) => s.toUpperCase()));
  let rows = (await fetchSnapshotRows()).filter((x) => set.has(x.symbol) && x.price >= minPrice && x.volume >= minVol);
  if (sort === "gainers") rows.sort((a, b) => b.changePct - a.changePct);
  else if (sort === "active") rows.sort((a, b) => b.volume - a.volume);
  else rows.sort((a, b) => a.changePct - b.changePct); // losers (default) — best for oversold pullbacks
  return { index, sort, members: set.size, matched: rows.length, tickers: rows.slice(0, limit) };
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

  // ---- Index scan: best pullback candidates within S&P 500 / NDX-100 / Dow 30 ----
  if (u.pathname === "/api/indexscan") {
    const index = (u.searchParams.get("index") || "sp500").toLowerCase();
    const sort = u.searchParams.get("sort") || "losers";
    const limit = Math.min(100, +(u.searchParams.get("limit") || 40));
    const minPrice = +(u.searchParams.get("minPrice") || 5);
    const minVol = +(u.searchParams.get("minVol") || 1000000);
    try { return send(res, 200, await polygonIndexScan(index, sort, limit, minPrice, minVol)); }
    catch (e) { return send(res, e.status || 502, { error: e.msg || "index scan failed" }); }
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
