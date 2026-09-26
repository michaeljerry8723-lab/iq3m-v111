#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {SYMBOLS} from "./strategy-v13.1.1.js";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(ROOT,"data");
const token=String(process.env.TIINGO_API_TOKEN||"").trim();
if(!token)throw new Error("TIINGO_API_TOKEN is required.");

const ymd=d=>d.toISOString().slice(0,10);
const ticker=s=>s.replace("/","").toLowerCase();
const months=Math.max(1,Math.min(24,Number(process.env.BACKTEST_MONTHS||6)));
const defaultEnd=ymd(new Date(Date.now()-86400000));
const end=new Date((process.env.BACKTEST_END||defaultEnd)+"T00:00:00Z");
const start=new Date(end);start.setUTCMonth(start.getUTCMonth()-months);

async function requestJson(url){
  const r=await fetch(url,{headers:{Accept:"application/json"}});
  const body=await r.text();

  if(r.status===429){
    let detail=body;
    try{detail=JSON.parse(body)?.detail||body;}catch(_){}
    throw new Error(
      "TIINGO_DAILY_QUOTA_EXCEEDED: "+detail+
      " Stop retrying today; wait for the Tiingo daily allocation to reset, then run the workflow once."
    );
  }
  if(!r.ok)throw new Error(`Tiingo HTTP ${r.status}: ${body.slice(0,500)}`);
  return JSON.parse(body);
}

function normalize(rows){
  return rows.map(x=>({
    t:Date.parse(x.date),
    o:+x.open,
    h:+x.high,
    l:+x.low,
    c:+x.close,
    n:+(x.volume||1)
  })).filter(x=>Number.isFinite(x.t)&&[x.o,x.h,x.l,x.c].every(Number.isFinite));
}

await fs.mkdir(DATA,{recursive:true});

const manifest={
  provider:"Tiingo FX 1-minute OHLC",
  generatedAt:new Date().toISOString(),
  requestMode:"one-request-per-symbol",
  expectedApiRequests:SYMBOLS.length,
  period:{start:ymd(start),endExclusive:ymd(end)},
  symbols:{}
};

console.log(
  `Fetching ${months} month(s) for ${SYMBOLS.length} FX pairs using one Tiingo request per pair (${SYMBOLS.length} total requests).`
);

for(const symbol of SYMBOLS){
  const url=
    `https://api.tiingo.com/tiingo/fx/${ticker(symbol)}/prices`+
    `?startDate=${ymd(start)}&endDate=${ymd(end)}&resampleFreq=1min&token=${encodeURIComponent(token)}`;

  console.log(`Requesting ${symbol}...`);
  const rows=await requestJson(url);
  const bars=normalize(Array.isArray(rows)?rows:[]);
  const dedup=[...new Map(bars.sort((a,b)=>a.t-b.t).map(x=>[x.t,x])).values()];

  if(!dedup.length)throw new Error(`Tiingo returned no 1-minute bars for ${symbol}.`);

  const file=ticker(symbol)+".json";
  await fs.writeFile(path.join(DATA,file),JSON.stringify({symbol,bars:dedup})+"\n");

  manifest.symbols[symbol]={
    file,
    bars:dedup.length,
    first:dedup[0]?.t??null,
    last:dedup.at(-1)?.t??null
  };

  // Persist progress after each successful pair. If a later request fails,
  // the workflow artifact still shows exactly how far the download got.
  manifest.generatedAt=new Date().toISOString();
  await fs.writeFile(path.join(DATA,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  console.log(`${symbol}: ${dedup.length} bars saved.`);
}

console.log("Historical download complete with",SYMBOLS.length,"Tiingo requests.");
