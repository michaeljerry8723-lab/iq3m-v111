#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {SYMBOLS} from "./strategy-v13.1.1.js";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(ROOT,"data");
const tiingoToken=String(process.env.TIINGO_API_TOKEN||"").trim();
const twelveKey=String(process.env.TWELVE_DATA_API_KEY||"").trim();
const requestedProvider=String(process.env.BACKTEST_PROVIDER||"TWELVE_DATA").trim().toUpperCase();

const ymd=d=>d.toISOString().slice(0,10);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ticker=s=>s.replace("/","").toLowerCase();
const months=Math.max(1,Math.min(12,Number(process.env.BACKTEST_MONTHS||6)));
const defaultEnd=ymd(new Date(Date.now()-86400000));
const end=new Date((process.env.BACKTEST_END||defaultEnd)+"T00:00:00Z");
const start=new Date(end);start.setUTCMonth(start.getUTCMonth()-months);

if(!["AUTO","TIINGO","TWELVE_DATA"].includes(requestedProvider)){
  throw new Error("BACKTEST_PROVIDER must be AUTO, TIINGO, or TWELVE_DATA.");
}
if(!(end>start))throw new Error("Invalid historical backtest date range.");

function normalizeTiingo(rows){
  return rows.map(x=>({
    t:Date.parse(x.date),
    o:+x.open,h:+x.high,l:+x.low,c:+x.close,n:+(x.volume||1)
  })).filter(x=>Number.isFinite(x.t)&&x.t>=+start&&x.t<+end&&[x.o,x.h,x.l,x.c].every(Number.isFinite));
}
function parseTwelveTime(value){
  const raw=String(value||"").trim();
  if(!raw)return NaN;
  const iso=raw.includes("T")?raw:raw.replace(" ","T");
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(iso)?iso:iso+"Z");
}
function normalizeTwelve(rows){
  return rows.map(x=>({
    t:parseTwelveTime(x.datetime),
    o:+x.open,h:+x.high,l:+x.low,c:+x.close,n:1
  })).filter(x=>Number.isFinite(x.t)&&x.t>=+start&&x.t<+end&&[x.o,x.h,x.l,x.c].every(Number.isFinite));
}
const dedupe=rows=>[...new Map(rows.sort((a,b)=>a.t-b.t).map(x=>[x.t,x])).values()];

async function resetData(){
  await fs.mkdir(DATA,{recursive:true});
  const names=await fs.readdir(DATA).catch(()=>[]);
  for(const name of names){
    if(name==="manifest.json"||name.endsWith(".json"))await fs.rm(path.join(DATA,name),{force:true});
  }
}
async function writePair(symbol,bars,manifest){
  const file=ticker(symbol)+".json";
  await fs.writeFile(path.join(DATA,file),JSON.stringify({symbol,bars})+"\n");
  manifest.symbols[symbol]={
    file,bars:bars.length,first:bars[0]?.t??null,last:bars.at(-1)?.t??null
  };
  manifest.generatedAt=new Date().toISOString();
  await fs.writeFile(path.join(DATA,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
}

async function requestTiingo(url){
  const r=await fetch(url,{headers:{Accept:"application/json"}});
  const body=await r.text();
  if(r.status===429){
    let detail=body;
    try{detail=JSON.parse(body)?.detail||body;}catch(_){}
    const e=new Error("TIINGO_QUOTA: "+detail);
    e.code="TIINGO_QUOTA";
    throw e;
  }
  if(!r.ok)throw new Error(`Tiingo HTTP ${r.status}: ${body.slice(0,500)}`);
  return JSON.parse(body);
}
async function downloadTiingo(){
  if(!tiingoToken)throw new Error("TIINGO_API_TOKEN is unavailable.");
  await resetData();
  const manifest={
    provider:"Tiingo FX 1-minute OHLC",
    providerCode:"TIINGO",
    generatedAt:new Date().toISOString(),
    requestMode:"one-request-per-symbol",
    expectedApiRequests:SYMBOLS.length,
    period:{start:ymd(start),endExclusive:ymd(end)},
    symbols:{}
  };
  console.log(`Tiingo: fetching ${months} month(s), six FX pairs, approximately ${SYMBOLS.length} requests.`);
  for(const symbol of SYMBOLS){
    const url=
      `https://api.tiingo.com/tiingo/fx/${ticker(symbol)}/prices`+
      `?startDate=${ymd(start)}&endDate=${ymd(end)}&resampleFreq=1min&token=${encodeURIComponent(tiingoToken)}`;
    console.log(`Tiingo: requesting ${symbol}...`);
    const rows=await requestTiingo(url);
    const bars=dedupe(normalizeTiingo(Array.isArray(rows)?rows:[]));
    if(!bars.length)throw new Error(`Tiingo returned no usable 1-minute bars for ${symbol}.`);
    await writePair(symbol,bars,manifest);
    console.log(`Tiingo: ${symbol} saved (${bars.length} bars).`);
  }
  return manifest;
}

let twelveRequestCount=0;
async function requestTwelve(url){
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(url,{headers:{Accept:"application/json"}});
    const body=await r.text();
    let payload=null;
    try{payload=JSON.parse(body);}catch(_){}

    const apiCode=Number(payload?.code||0);
    const isRateLimit=r.status===429||apiCode===429;
    if(isRateLimit){
      const msg=String(payload?.message||body||"Twelve Data rate limit reached");
      if(/daily|800|day limit/i.test(msg)){
        const e=new Error("TWELVE_DATA_DAILY_QUOTA: "+msg);
        e.code="TWELVE_DATA_DAILY_QUOTA";
        throw e;
      }
      if(attempt<3){
        console.log("Twelve Data minute credit limit reached; waiting 65 seconds before retry.");
        await sleep(65000);
        continue;
      }
    }

    if(!r.ok||payload?.status==="error"){
      throw new Error(`Twelve Data HTTP/API ${r.status||apiCode}: ${String(payload?.message||body).slice(0,500)}`);
    }
    return payload;
  }
  throw new Error("Twelve Data request failed after rate-limit retries.");
}
function windows(from,to,days=3){
  const out=[];let cursor=new Date(from);
  while(cursor<to){
    const next=new Date(Math.min(+to,+cursor+days*86400000));
    out.push([new Date(cursor),next]);
    cursor=next;
  }
  return out;
}
const twelveDateTime=d=>d.toISOString().slice(0,19).replace("T"," ");

async function downloadTwelve(){
  if(!twelveKey)throw new Error("TWELVE_DATA_API_KEY is unavailable.");
  await resetData();

  const chunks=windows(start,end,3);
  const expected=chunks.length*SYMBOLS.length;
  if(expected>800){
    throw new Error(
      `Twelve Data Basic daily allowance may be insufficient: this run needs about ${expected} credits. Reduce BACKTEST_MONTHS.`
    );
  }

  const manifest={
    provider:"Twelve Data FX 1-minute OHLC",
    providerCode:"TWELVE_DATA",
    generatedAt:new Date().toISOString(),
    requestMode:"3-calendar-day windows, sequentially throttled",
    expectedApiRequests:expected,
    period:{start:ymd(start),endExclusive:ymd(end)},
    symbols:{}
  };

  console.log(
    `Twelve Data: fetching ${months} month(s) for ${SYMBOLS.length} FX pairs in ${chunks.length} windows per pair (~${expected} credits).`
  );

  for(const symbol of SYMBOLS){
    const all=[];
    for(let i=0;i<chunks.length;i++){
      const [a,b]=chunks[i];
      const params=new URLSearchParams({
        symbol,
        interval:"1min",
        start_date:twelveDateTime(a),
        end_date:twelveDateTime(b),
        timezone:"UTC",
        order:"asc",
        apikey:twelveKey
      });
      const url="https://api.twelvedata.com/time_series?"+params.toString();
      console.log(`Twelve Data: ${symbol} window ${i+1}/${chunks.length} (${ymd(a)} → ${ymd(b)})`);
      const payload=await requestTwelve(url);
      twelveRequestCount++;
      all.push(...normalizeTwelve(Array.isArray(payload?.values)?payload.values:[]));

      // Basic plan is 8 API credits/minute. One time_series symbol costs one
      // credit, so 8.2 seconds keeps this workflow just below that ceiling.
      if(!(symbol===SYMBOLS.at(-1)&&i===chunks.length-1))await sleep(8200);
    }

    const bars=dedupe(all);
    if(!bars.length)throw new Error(`Twelve Data returned no usable 1-minute bars for ${symbol}.`);
    await writePair(symbol,bars,manifest);
    console.log(`Twelve Data: ${symbol} saved (${bars.length} bars).`);
  }
  manifest.actualApiRequests=twelveRequestCount;
  await fs.writeFile(path.join(DATA,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  return manifest;
}

async function main(){
  console.log(`Historical provider requested: ${requestedProvider}`);

  let manifest;
  if(requestedProvider==="TIINGO"){
    manifest=await downloadTiingo();
  }else if(requestedProvider==="TWELVE_DATA"){
    manifest=await downloadTwelve();
  }else{
    if(tiingoToken){
      try{
        manifest=await downloadTiingo();
      }catch(e){
        if(!twelveKey)throw e;
        console.warn(`AUTO: Tiingo unavailable (${String(e?.message||e)}). Restarting the entire download with Twelve Data so feeds are never mixed.`);
        manifest=await downloadTwelve();
      }
    }else{
      manifest=await downloadTwelve();
    }
  }

  console.log(
    `Historical download complete. Provider=${manifest.providerCode}; period=${manifest.period.start}..${manifest.period.endExclusive}; symbols=${Object.keys(manifest.symbols).length}`
  );
}

main().catch(e=>{
  console.error(`Historical download failed: ${String(e?.message||e)}`);
  process.exitCode=2;
});
