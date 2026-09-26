#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {SYMBOLS} from "./strategy-v13.1.1.js";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(ROOT,"data");
const token=String(process.env.TIINGO_API_TOKEN||"").trim();
if(!token)throw new Error("TIINGO_API_TOKEN is required.");

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ymd=d=>d.toISOString().slice(0,10);
const ticker=s=>s.replace("/","").toLowerCase();
const months=Math.max(1,Math.min(24,Number(process.env.BACKTEST_MONTHS||6)));
const defaultEnd=ymd(new Date(Date.now()-86400000));
const end=new Date((process.env.BACKTEST_END||defaultEnd)+"T00:00:00Z");
const start=new Date(end);start.setUTCMonth(start.getUTCMonth()-months);

async function requestJson(url,attempt=0){
  const r=await fetch(url,{headers:{Accept:"application/json"}});
  if((r.status===429||r.status>=500)&&attempt<6){
    const wait=Math.max(1000,Number(r.headers.get("retry-after")||0)*1000||1500*(attempt+1));
    await sleep(wait);
    return requestJson(url,attempt+1);
  }
  if(!r.ok)throw new Error(`Tiingo HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.json();
}
function chunks(a,b,days=30){
  const out=[];let cur=new Date(a);
  while(cur<b){const nxt=new Date(Math.min(+b,+cur+days*86400000));out.push([new Date(cur),nxt]);cur=nxt;}
  return out;
}
function normalize(rows){
  return rows.map(x=>({
    t:Date.parse(x.date),o:+x.open,h:+x.high,l:+x.low,c:+x.close,n:+(x.volume||1)
  })).filter(x=>Number.isFinite(x.t)&&[x.o,x.h,x.l,x.c].every(Number.isFinite));
}

await fs.mkdir(DATA,{recursive:true});
const manifest={
  provider:"Tiingo FX 1-minute OHLC",
  generatedAt:new Date().toISOString(),
  period:{start:ymd(start),endExclusive:ymd(end)},
  symbols:{}
};

for(const symbol of SYMBOLS){
  const all=[];
  for(const [a,b] of chunks(start,end)){
    const url=`https://api.tiingo.com/tiingo/fx/${ticker(symbol)}/prices?startDate=${ymd(a)}&endDate=${ymd(b)}&resampleFreq=1min&token=${encodeURIComponent(token)}`;
    const rows=await requestJson(url);
    all.push(...normalize(Array.isArray(rows)?rows:[]));
    await sleep(250);
  }
  const dedup=[...new Map(all.sort((a,b)=>a.t-b.t).map(x=>[x.t,x])).values()];
  const file=ticker(symbol)+".json";
  await fs.writeFile(path.join(DATA,file),JSON.stringify({symbol,bars:dedup})+"\n");
  manifest.symbols[symbol]={file,bars:dedup.length,first:dedup[0]?.t??null,last:dedup.at(-1)?.t??null};
  console.log(symbol,dedup.length);
}
await fs.writeFile(path.join(DATA,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log("Saved",path.join(DATA,"manifest.json"));
