#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  SYMBOLS,VERSION,STRATEGY_ID,PREPARE_TTL_MS,EXPIRY_MS,
  sequenceSnapshot,preliminaryCore,finalHistoricalCore,pairCooldown,riskGate,usdExposureSide
} from "./strategy-v13.1.1.js";
import {calculateMetrics,splitSamples,csv} from "./metrics.js";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(ROOT,"data");
const RESULTS=path.join(ROOT,"results");
const add=(rows,filter,at,symbol=null)=>rows.push({filter,at,symbol,month:new Date(at).toISOString().slice(0,7)});

async function loadData(){
  const manifest=JSON.parse(await fs.readFile(path.join(DATA,"manifest.json"),"utf8")),out={};
  for(const symbol of SYMBOLS){
    const meta=manifest.symbols[symbol];if(!meta)throw new Error(`manifest lacks ${symbol}`);
    const data=JSON.parse(await fs.readFile(path.join(DATA,meta.file),"utf8"));
    out[symbol]=data.bars.map(b=>({...b,t:+b.t,o:+b.o,h:+b.h,l:+b.l,c:+b.c})).sort((a,b)=>a.t-b.t);
  }
  return {manifest,barsBySymbol:out};
}
export function settle(signal,bars){
  const expiryAt=signal.entryAt+EXPIRY_MS;
  const bar=bars.find(b=>b.t>=signal.entryAt&&b.t+60000>=expiryAt);
  if(!bar)return {...signal,result:"VOID",expiryAt,expiryPrice:null,settledAt:expiryAt,settlementNote:"No legitimate 1-minute close at/after expiry"};
  const expiryPrice=+bar.c,delta=expiryPrice-signal.entryPrice;let result="DRAW";
  if(delta!==0)result=(signal.direction==="CALL"?delta>0:delta<0)?"WIN":"LOSS";
  return {...signal,result,expiryAt,expiryPrice,settledAt:bar.t+60000,settlementBarT:bar.t,settlementNote:"Closest legitimate 1-minute close at or after 120-second expiry; intra-minute precision unavailable"};
}
function monthsInPeriod(manifest){
  const out=[];let d=new Date(manifest.period.start+"T00:00:00Z"),end=new Date(manifest.period.endExclusive+"T00:00:00Z");
  while(d<end){out.push(d.toISOString().slice(0,7));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}
  return out;
}
function subsetMetrics(name,months,signals,prepares,rejections,tradingDays,period){
  const wanted=new Set(months);
  return calculateMetrics({
    mode:`MODE_A_HISTORICAL_CORE_${name}`,period,
    signals:signals.filter(x=>wanted.has(x.month)),
    prepares:prepares.filter(x=>wanted.has(x.month)),
    rejections:rejections.filter(x=>wanted.has(x.month)),
    tradingDays:[...tradingDays].filter(x=>wanted.has(x.slice(0,7))).length
  });
}

export async function replay({write=true}={}){
  const {manifest,barsBySymbol}=await loadData();
  const states=Object.fromEntries(SYMBOLS.map(s=>[s,{stage:"SEEK",direction:null,lastBarT:0,updatedAt:0}]));
  const contexts=Object.fromEntries(SYMBOLS.map(s=>[s,[]]));
  const closes=new Map();

  for(const symbol of SYMBOLS){
    for(const b of barsBySymbol[symbol]){
      const at=b.t+60000;
      if(!closes.has(at))closes.set(at,[]);
      closes.get(at).push([symbol,b]);
    }
  }

  const signals=[],prepares=[],rejections=[],tradingDays=new Set();
  const times=[...closes.keys()].sort((a,b)=>a-b);

  for(const now of times){
    for(const [symbol,bar] of closes.get(now)){
      contexts[symbol].push(bar);
      if(contexts[symbol].length>500)contexts[symbol].shift();
      tradingDays.add(new Date(bar.t).toISOString().slice(0,10));
    }

    const gate=riskGate(signals,now);
    if(!gate.ok){add(rejections,gate.filter,now);continue;}
    const qualified=[];

    for(const symbol of SYMBOLS){
      const bars=contexts[symbol],last=bars.at(-1);
      if(!last||last.t+60000!==now||bars.length<80)continue;
      if(pairCooldown(signals,symbol,now)){add(rejections,"pair_cooldown",now,symbol);continue;}

      let st=states[symbol],snap=sequenceSnapshot(bars,now);

      if(!snap.ready||snap.direction==="NEUTRAL"||!snap.structureOk){
        if(st.stage==="PREPARE"||st.stage==="READY")add(rejections,"prepare_cancelled_structure",now,symbol);
        states[symbol]={stage:"SEEK",direction:null,lastBarT:snap.barT||0,updatedAt:now};
        continue;
      }

      if(st.direction!==snap.direction||now-st.updatedAt>2100000){
        if(st.stage==="PREPARE"||st.stage==="READY")add(rejections,st.direction!==snap.direction?"prepare_cancelled_direction":"prepare_expired_stale",now,symbol);
        states[symbol]={stage:"ARMED",direction:snap.direction,lastBarT:snap.barT,updatedAt:now};
        continue;
      }

      if((st.stage==="PREPARE"||st.stage==="READY")&&now-(st.prepareAt||st.updatedAt)>PREPARE_TTL_MS){
        add(rejections,"prepare_expired_confirmation",now,symbol);
        states[symbol]={stage:"ARMED",direction:snap.direction,lastBarT:snap.barT,updatedAt:now};
        continue;
      }

      if(st.lastBarT!==snap.barT){
        if(st.stage==="SEEK")st={stage:"ARMED",direction:snap.direction,lastBarT:snap.barT,updatedAt:now};
        else if(st.stage==="ARMED"&&snap.pullbackSeen)st={stage:"PULLBACK",direction:snap.direction,lastBarT:snap.barT,updatedAt:now};
        else st={...st,lastBarT:snap.barT,updatedAt:now};
        states[symbol]=st;
      }

      if(st.stage==="PULLBACK"){
        const pre=preliminaryCore(bars,symbol,st.direction,now);
        if(!pre.ok){add(rejections,pre.filter,now,symbol);continue;}
        const setupId=`${symbol}|${st.direction}|${st.lastBarT}`;
        st={...st,stage:"PREPARE",prepareAt:now,readyAlertAt:now,setupCandleT:st.lastBarT,setupId,preScore:pre.preScore};
        states[symbol]=st;
        prepares.push({setupId,symbol,direction:st.direction,setupCandleT:st.setupCandleT,readyAlertAt:now,month:new Date(now).toISOString().slice(0,7),...pre});
        continue;
      }

      if(st.stage!=="PREPARE")continue;

      const pre=preliminaryCore(bars,symbol,st.direction,now);
      if(!pre.ok){
        add(rejections,pre.filter,now,symbol);
        states[symbol]={stage:"SEEK",direction:null,lastBarT:st.lastBarT,updatedAt:now};
        continue;
      }

      const core=finalHistoricalCore(bars,symbol,st.direction,now);
      if(!core.ok){add(rejections,core.filter,now,symbol);continue;}

      states[symbol]={...st,stage:"READY",readyBarT:last.t,updatedAt:now};
      qualified.push({
        symbol,setupId:st.setupId,readyAlertAt:st.readyAlertAt,
        entryAt:now,entryPrice:last.c,month:new Date(now).toISOString().slice(0,7),...core
      });
    }

    qualified.sort((a,b)=>b.quality-a.quality);

    for(const candidate of qualified){
      const side=usdExposureSide(candidate.symbol,candidate.direction);
      const conflict=signals.some(x=>
        x.entryAt<=now&&x.expiryAt>now&&x.symbol!==candidate.symbol&&usdExposureSide(x.symbol,x.direction)===side
      );
      if(conflict){
        add(rejections,"usd_correlated_exposure",now,candidate.symbol);
        states[candidate.symbol]={stage:"SEEK",direction:null,lastBarT:0,updatedAt:now};
        continue;
      }
      const settled=settle(candidate,barsBySymbol[candidate.symbol]);
      signals.push(settled);
      states[candidate.symbol]={stage:"SEEK",direction:null,lastBarT:0,updatedAt:now};
      break;
    }
  }

  const months=monthsInPeriod(manifest),split=splitSamples(months),period=manifest.period;
  const report={
    status:"complete",version:VERSION,strategyId:STRATEGY_ID,generatedAt:new Date().toISOString(),
    provider:manifest.provider||"Historical FX 1-minute OHLC",
    modeA:{
      available:true,
      spreadFilter:"UNAVAILABLE unless genuine bid/ask fields exist; no spread was fabricated",
      microData:"Not used"
    },
    modeB:{
      available:false,
      reason:"Genuine historical 30-second bars and live ticks were not supplied; no micro-data was synthesized"
    },
    settlementLimitation:"1-minute closes cannot reproduce exact intra-minute Pocket Option settlement quotes",
    development:subsetMetrics("DEVELOPMENT",split.development,signals,prepares,rejections,tradingDays,period),
    holdout:subsetMetrics("HOLDOUT",split.holdout,signals,prepares,rejections,tradingDays,period),
    overall:calculateMetrics({mode:"MODE_A_HISTORICAL_CORE",period,signals,prepares,rejections,tradingDays:tradingDays.size}),
    months:split
  };

  if(write){
    await fs.mkdir(RESULTS,{recursive:true});
    await fs.writeFile(path.join(RESULTS,"results.json"),JSON.stringify(report,null,2)+"\n");
    await fs.writeFile(path.join(RESULTS,"signals.csv"),csv(signals));
    await fs.writeFile(path.join(RESULTS,"prepare-setups.csv"),csv(prepares));
    await fs.writeFile(path.join(RESULTS,"filter-rejections.csv"),csv(rejections));
    await fs.writeFile(path.join(ROOT,"BACKTEST_REPORT.md"),renderReport(report));
  }
  return {report,signals,prepares};
}

const pct=x=>x==null?"n/a":`${(x*100).toFixed(2)}%`;
export function renderReport(r){
  const section=(title,x)=>`## ${title}

- Trading days: ${x.tradingDays}
- PREPARE setups: ${x.totalPrepareSetups}
- PREPARE → testable candidate: ${pct(x.prepareToCandidateRate)}
- Testable historical-core candidates: ${x.totalTestableSignals}
- W/L/D/V: ${x.wins}/${x.losses}/${x.draws}/${x.voids}
- Win rate excluding draws: ${pct(x.winRateExcludingDraws)}
- Signals/day: ${x.signalsPerDay==null?"n/a":x.signalsPerDay.toFixed(3)}
- Longest win/loss streak: ${x.longestWinningStreak}/${x.longestLosingStreak}

`;

  return `# V13.1.1 Historical Backtest Report

**Strategy:** ${r.version}  
**Reference feed:** ${r.provider}

Mode A evaluates only truthfully reproducible 1-minute historical-core rules. It does not fabricate the production 30-second/live-tick confirmation or bid/ask spread.

${section("Development sample",r.development)}${section("Holdout sample",r.holdout)}${section("Overall diagnostic",r.overall)}
## Interpretation limits

These are historical-core candidates, not full-fidelity live V13.1.1 signals. Settlement uses the closest legitimate 1-minute close at or after 120 seconds. The provider shown above is the reference feed for this run; results do not reproduce Pocket Option execution or settlement prices.
`;
}

if(import.meta.url===`file://${process.argv[1]}`){
  replay().then(({report})=>{
    console.log(JSON.stringify({
      status:report.status,
      development:report.development.totalTestableSignals,
      holdout:report.holdout.totalTestableSignals,
      overall:report.overall.totalTestableSignals
    },null,2));
  }).catch(e=>{
    console.error(`Backtest unavailable: ${e.message}`);
    process.exitCode=2;
  });
}
