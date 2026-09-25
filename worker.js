// V11.1 — 15-second tick sniper with Cloudflare Durable Object
import { DurableObject } from "cloudflare:workers";

const VERSION = "11.9.0-five-minute-revalidated-entry";
const DEFAULT_SYMBOLS = "EUR/USD,USD/JPY,GBP/USD,USD/CAD,AUD/USD,USD/CHF";
const FIXED_UNIVERSE = DEFAULT_SYMBOLS.split(",");
const EXPIRY_SECONDS = 300;
const STRATEGY_ID = "5m-revalidated-v11.9";
const GLOBAL_SIGNAL_COOLDOWN_MS = 6*60*1000;
const PAIR_SIGNAL_COOLDOWN_MS = 10*60*1000;
const LOSS_CIRCUIT_BREAKER_MS = 20*60*1000;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function clamp(x,a,b){ return Math.max(a,Math.min(b,Number(x)||0)); }
function mean(xs){ return xs.length ? xs.reduce((a,b)=>a+Number(b),0)/xs.length : NaN; }
function normalizeSymbol(input){
  let s=String(input||"").trim().toUpperCase().replace(/\s+/g,"");
  s=s.replace(/[-_]/g,"/");
  if(/^[A-Z]{6}$/.test(s)) s=s.slice(0,3)+"/"+s.slice(3);
  return /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(s) ? s : null;
}
function toTiingoSymbol(symbol){
  const s=normalizeSymbol(symbol);
  return s ? s.replace("/","").toLowerCase() : null;
}
function fromTiingoSymbol(ticker){
  const x=String(ticker||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
  return /^[A-Z]{6}$/.test(x) ? x.slice(0,3)+"/"+x.slice(3) : normalizeSymbol(x);
}
function tsMs(t){ const n=Number(t); if(!Number.isFinite(n)) return Date.now(); return n<1e12?n*1000:n; }
function json(data,status=200){ return new Response(JSON.stringify(data,null,2),{status,headers:{"content-type":"application/json;charset=UTF-8"}}); }
function formatFxPrice(symbol,p){
  const n=Number(p);
  if(!Number.isFinite(n))return "n/a";
  return n.toFixed(String(symbol||"").endsWith("/JPY")?3:5);
}

function buildBars(ticks, seconds){
  const m=new Map(), span=seconds*1000;
  for(const t of ticks){
    const b=Math.floor(t.t/span)*span;
    let x=m.get(b);
    if(!x){ x={t:b,o:t.p,h:t.p,l:t.p,c:t.p,n:1}; m.set(b,x); }
    else { x.h=Math.max(x.h,t.p); x.l=Math.min(x.l,t.p); x.c=t.p; x.n++; }
  }
  return [...m.values()].sort((a,b)=>a.t-b.t);
}
function emaSeries(vals,p){
  p=Math.max(2,Math.floor(p)); const out=new Array(vals.length).fill(NaN); if(vals.length<p)return out;
  let seed=mean(vals.slice(0,p)); out[p-1]=seed; const k=2/(p+1);
  for(let i=p;i<vals.length;i++) out[i]=Number(vals[i])*k+out[i-1]*(1-k);
  return out;
}
function smaSeries(vals,p){
  p=Math.max(2,Math.floor(p)); const out=new Array(vals.length).fill(NaN);
  if(vals.length<p)return out;
  let sum=0;
  for(let i=0;i<vals.length;i++){
    sum+=Number(vals[i]);
    if(i>=p)sum-=Number(vals[i-p]);
    if(i>=p-1)out[i]=sum/p;
  }
  return out;
}
function smmaSeries(vals,p){
  p=Math.max(2,Math.floor(p)); const out=new Array(vals.length).fill(NaN); if(vals.length<p)return out;
  let seed=mean(vals.slice(0,p)); out[p-1]=seed;
  for(let i=p;i<vals.length;i++) out[i]=(out[i-1]*(p-1)+Number(vals[i]))/p;
  return out;
}
function macdSnapshot(bars,fast=3,slow=8,signal=3){
  if(!bars || bars.length<slow+signal+3)return {ready:false};
  const c=bars.map(b=>Number(b.c)), ef=emaSeries(c,fast), es=emaSeries(c,slow), m=[];
  for(let i=0;i<c.length;i++) if(Number.isFinite(ef[i])&&Number.isFinite(es[i])) m.push(ef[i]-es[i]);
  if(m.length<signal+3)return {ready:false};
  const sig=emaSeries(m,signal), i=m.length-1;
  const hist=m[i]-sig[i], ph=m[i-1]-sig[i-1], p2=m[i-2]-sig[i-2];
  return {ready:true,macd:m[i],signal:sig[i],hist,prevHist:ph,rising:hist>ph&&ph>=p2,falling:hist<ph&&ph<=p2};
}
function alligatorSnapshot(bars){
  if(!bars || bars.length<22)return {ready:false};
  const med=bars.map(b=>(Number(b.h)+Number(b.l))/2);
  const jaws=smmaSeries(med,13), teeth=smmaSeries(med,8), lips=smmaSeries(med,5), i=bars.length-1;
  const j=jaws[i-3],t=teeth[i-2],l=lips[i-1], pj=jaws[i-4],pt=teeth[i-3],pl=lips[i-2];
  if(![j,t,l,pj,pt,pl].every(Number.isFinite))return {ready:false};
  return {ready:true,jaws:j,teeth:t,lips:l,jawsSlope:j-pj,teethSlope:t-pt,lipsSlope:l-pl,gap:Math.abs(l-j),prevGap:Math.abs(pl-pj)};
}
function aroonSnapshot(bars,p=7){
  if(!bars || bars.length<p+1)return {ready:false};
  const xs=bars.slice(-p); let hi=-Infinity,lo=Infinity,hiIdx=0,loIdx=0;
  xs.forEach((b,i)=>{ if(Number(b.h)>=hi){hi=Number(b.h);hiIdx=i;} if(Number(b.l)<=lo){lo=Number(b.l);loIdx=i;} });
  const sinceHi=p-1-hiIdx, sinceLo=p-1-loIdx;
  return {ready:true,up:100*(p-sinceHi)/p,down:100*(p-sinceLo)/p,spread:100*((p-sinceHi)-(p-sinceLo))/p};
}
function fractalSnapshot(bars,p=2){
  p=Math.max(1,Math.floor(p));
  if(!bars || bars.length<(p*2+3))return {ready:false};
  let lastHigh=null,lastLow=null;
  for(let i=p;i<bars.length-p;i++){
    const b=bars[i];
    let high=true,low=true;
    for(let k=1;k<=p;k++){
      if(!(Number(b.h)>Number(bars[i-k].h)&&Number(b.h)>Number(bars[i+k].h)))high=false;
      if(!(Number(b.l)<Number(bars[i-k].l)&&Number(b.l)<Number(bars[i+k].l)))low=false;
    }
    if(high)lastHigh={price:Number(b.h),t:b.t};
    if(low)lastLow={price:Number(b.l),t:b.t};
  }
  return {ready:Boolean(lastHigh||lastLow),lastHigh,lastLow,period:p};
}
function tickImpulse(ticks){
  const xs=ticks.slice(-24); if(xs.length<8)return {ready:false};
  let up=0,down=0,abs=0;
  for(let i=1;i<xs.length;i++){
    const d=xs[i].p-xs[i-1].p; if(d>0)up++; else if(d<0)down++; abs+=Math.abs(d);
  }
  const delta=xs.at(-1).p-xs[0].p, avg=abs/Math.max(1,xs.length-1);
  return {ready:true,upRatio:up/Math.max(1,up+down),downRatio:down/Math.max(1,up+down),delta,norm:avg>0?delta/avg:0};
}

function smaTrendSnapshot(bars,fast=2,slow=5){
  if(!bars || bars.length<slow+2)return {ready:false};
  const c=bars.map(b=>Number(b.c)), sf=smaSeries(c,fast), ss=smaSeries(c,slow), i=c.length-1;
  if(![sf[i],sf[i-1],ss[i],ss[i-1]].every(Number.isFinite))return {ready:false};
  return {
    ready:true,
    fast:sf[i],slow:ss[i],
    prevFast:sf[i-1],prevSlow:ss[i-1],
    fastSlope:sf[i]-sf[i-1],
    slowSlope:ss[i]-ss[i-1],
    crossedUp:sf[i]>ss[i]&&sf[i-1]<=ss[i-1],
    crossedDown:sf[i]<ss[i]&&sf[i-1]>=ss[i-1]
  };
}
function parseUtcDateTime(v){
  const x=String(v||"").trim().replace(" ","T");
  if(!x)return NaN;
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(x)?x:x+"Z");
}

function aggregateOhlcBars(bars,seconds){
  const span=seconds*1000, m=new Map();
  for(const b of bars||[]){
    const bucket=Math.floor(Number(b.t)/span)*span;
    let x=m.get(bucket);
    if(!x){
      x={t:bucket,o:Number(b.o),h:Number(b.h),l:Number(b.l),c:Number(b.c),n:Number(b.n||1)};
      m.set(bucket,x);
    }else{
      x.h=Math.max(x.h,Number(b.h));
      x.l=Math.min(x.l,Number(b.l));
      x.c=Number(b.c);
      x.n+=Number(b.n||1);
    }
  }
  return [...m.values()].sort((a,b)=>a.t-b.t);
}
function atrSnapshot(bars,p=14){
  if(!bars||bars.length<p+1)return {ready:false};
  const xs=bars.slice(-(p+1)); let sum=0;
  for(let i=1;i<xs.length;i++){
    const h=Number(xs[i].h),l=Number(xs[i].l),pc=Number(xs[i-1].c);
    sum+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
  }
  return {ready:true,atr:sum/p};
}
function efficiencyRatio(bars,p=8){
  if(!bars||bars.length<p+1)return 0;
  const xs=bars.slice(-(p+1)).map(b=>Number(b.c));
  const net=Math.abs(xs.at(-1)-xs[0]);
  let travel=0;
  for(let i=1;i<xs.length;i++)travel+=Math.abs(xs[i]-xs[i-1]);
  return travel>0?net/travel:0;
}
function regime5mSnapshot(bars1m){
  const currentMinute=Math.floor(Date.now()/60000)*60000;
  const b5=aggregateOhlcBars(bars1m,300)
    .filter(b=>Number(b.t)+300000<=currentMinute);
  if(b5.length<15)return {ready:false,bars:b5.length};
  const c=b5.map(b=>Number(b.c)), e5=emaSeries(c,5), e13=emaSeries(c,13), i=c.length-1;
  if(![e5[i],e5[i-1],e13[i],e13[i-1]].every(Number.isFinite))return {ready:false,bars:b5.length};
  const eff=efficiencyRatio(b5,8);
  let direction="NEUTRAL";
  if(e5[i]>e13[i]&&e5[i]>e5[i-1]&&e13[i]>=e13[i-1]&&eff>=0.32)direction="CALL";
  if(e5[i]<e13[i]&&e5[i]<e5[i-1]&&e13[i]<=e13[i-1]&&eff>=0.32)direction="PUT";
  return {ready:true,direction,efficiency:eff,emaFast:e5[i],emaSlow:e13[i],bars:b5.length};
}

function rsiSnapshot(bars,p=7){
  if(!bars||bars.length<p+2)return {ready:false};
  const c=bars.map(b=>Number(b.c));
  let gains=0,losses=0;
  for(let i=c.length-p;i<c.length;i++){
    const d=c[i]-c[i-1];
    if(d>0)gains+=d; else losses-=d;
  }
  const avgGain=gains/p, avgLoss=losses/p;
  if(avgLoss===0)return {ready:true,rsi:100};
  const rs=avgGain/avgLoss;
  return {ready:true,rsi:100-(100/(1+rs))};
}
function dmiAdxSnapshot(bars,p=7){
  if(!bars||bars.length<(p*2+2))return {ready:false};
  const trs=[],plus=[],minus=[];
  for(let i=1;i<bars.length;i++){
    const h=Number(bars[i].h),l=Number(bars[i].l),ph=Number(bars[i-1].h),pl=Number(bars[i-1].l),pc=Number(bars[i-1].c);
    const up=h-ph, dn=pl-l;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    plus.push(up>dn&&up>0?up:0);
    minus.push(dn>up&&dn>0?dn:0);
  }
  const dx=[];
  for(let i=p-1;i<trs.length;i++){
    let tr=0,pdm=0,mdm=0;
    for(let j=i-p+1;j<=i;j++){tr+=trs[j];pdm+=plus[j];mdm+=minus[j];}
    if(tr<=0){dx.push(NaN);continue;}
    const pdi=100*pdm/tr, mdi=100*mdm/tr;
    dx.push((pdi+mdi)>0?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  }
  const valid=dx.filter(Number.isFinite);
  if(valid.length<p)return {ready:false};
  const adx=mean(valid.slice(-p));
  let tr=0,pdm=0,mdm=0;
  for(let j=trs.length-p;j<trs.length;j++){tr+=trs[j];pdm+=plus[j];mdm+=minus[j];}
  if(tr<=0)return {ready:false};
  return {ready:true,adx,plusDI:100*pdm/tr,minusDI:100*mdm/tr};
}
function candlePressure(bars,n=3){
  const xs=(bars||[]).slice(-n);
  if(xs.length<n)return {ready:false};
  let bull=0,bear=0;
  for(const b of xs){
    const d=Number(b.c)-Number(b.o);
    if(d>0)bull++; else if(d<0)bear++;
  }
  return {ready:true,bull,bear};
}

function score5m(ticks,bars1m){
  const bars15=buildBars(ticks,15);

  // 5-minute expiry: use a slower, more stable 1m trend core.
  // Do not block the whole strategy while the short-term tick layer is still accumulating.
  const sma1=smaTrendSnapshot(bars1m,5,13);
  const fr1=fractalSnapshot(bars1m,2);
  const m1=macdSnapshot(bars1m,5,13,4);
  const ar1=aroonSnapshot(bars1m,14);
  const atr1=atrSnapshot(bars1m,14);
  const regime=regime5mSnapshot(bars1m);
  const rsi1=rsiSnapshot(bars1m,7);
  const dmi=dmiAdxSnapshot(bars1m,7);
  const pressure=candlePressure(bars1m,3);

  if(!sma1.ready||!fr1.ready||!m1.ready||!ar1.ready||!atr1.ready||!rsi1.ready||!dmi.ready||!pressure.ready){
    return {ok:false,reason:"5-minute context not ready",bars15:bars15.length};
  }

  const last=Number(ticks.at(-1)?.p);
  const lastTick=ticks.at(-1)||{};
  const spread=Number(lastTick.ask)-Number(lastTick.bid);
  const spreadAtrRatio=Number.isFinite(spread)&&spread>=0&&atr1.atr>0?spread/atr1.atr:Infinity;
  const atrRatio=Number.isFinite(last)&&last>0?atr1.atr/last:0;

  if(!Number.isFinite(spreadAtrRatio)||spreadAtrRatio>0.22){
    return {ok:false,reason:"spread too wide for 5m entry",spreadAtrRatio,bars15:bars15.length};
  }
  if(atrRatio<0.000007||atrRatio>0.0030){
    return {ok:false,reason:"1m volatility outside 5m strategy range",atrRatio,bars15:bars15.length};
  }

  let direction="NEUTRAL";
  if(sma1.fast>sma1.slow&&sma1.fastSlope>0) direction="CALL";
  if(sma1.fast<sma1.slow&&sma1.fastSlope<0) direction="PUT";
  if(direction==="NEUTRAL"){
    return {ok:false,reason:"SMA(5/13) trend is not established",bars15:bars15.length};
  }

  // Structural invalidation stays hard.
  if(direction==="CALL"&&fr1.lastLow&&last<=fr1.lastLow.price){
    return {ok:false,reason:"Fractal(2) support failed",coreDirection:direction,bars15:bars15.length};
  }
  if(direction==="PUT"&&fr1.lastHigh&&last>=fr1.lastHigh.price){
    return {ok:false,reason:"Fractal(2) resistance failed",coreDirection:direction,bars15:bars15.length};
  }

  // A strongly opposite 5m regime still vetoes the entry.
  if(regime?.ready&&regime.direction!=="NEUTRAL"&&regime.direction!==direction&&regime.efficiency>=0.48){
    return {ok:false,reason:"5m regime strongly opposes the setup",coreDirection:direction,
      regimeDirection:regime.direction,regimeEfficiency:regime.efficiency,bars15:bars15.length};
  }

  if(atr1.atr>0){
    const distanceFast=Math.abs(last-sma1.fast)/atr1.atr;
    if(distanceFast>0.90){
      return {ok:false,reason:"price is too far from SMA(5) for a fresh 5m entry",distanceFastAtr:distanceFast,
        coreDirection:direction,bars15:bars15.length};
    }
  }

  const last1=bars1m.at(-1);
  if(last1&&atr1.atr>0){
    const extension=Math.abs(last-Number(last1.c))/atr1.atr;
    if(extension>1.8){
      return {ok:false,reason:"entry is too extended",extensionAtr:extension,coreDirection:direction,bars15:bars15.length};
    }
  }

  let score=3.2, confirms=1;
  const reasons=[`1m SMA(5/13) ${direction==="CALL"?"bullish":"bearish"}`];

  if((direction==="CALL"&&sma1.slowSlope>=0)||(direction==="PUT"&&sma1.slowSlope<=0)){
    score+=0.9;reasons.push("SMA(13) slope aligned");
  }
  if((direction==="CALL"&&sma1.crossedUp)||(direction==="PUT"&&sma1.crossedDown)){
    score+=0.6;reasons.push("fresh SMA(5/13) crossover");
  }

  if(fr1.lastLow&&fr1.lastHigh){
    const supportive=direction==="CALL"
      ? Number(fr1.lastLow.t)>Number(fr1.lastHigh.t)
      : Number(fr1.lastHigh.t)>Number(fr1.lastLow.t);
    if(supportive){score+=1.0;confirms++;reasons.push("Fractal(2) swing structure aligned");}
  }
  if(direction==="CALL"&&fr1.lastHigh&&last>fr1.lastHigh.price){
    score+=0.6;reasons.push("Fractal(2) breakout");
  }
  if(direction==="PUT"&&fr1.lastLow&&last<fr1.lastLow.price){
    score+=0.6;reasons.push("Fractal(2) breakdown");
  }

  const macdAligned=direction==="CALL"
    ? (m1.macd>m1.signal&&m1.hist>0)
    : (m1.macd<m1.signal&&m1.hist<0);
  if(macdAligned){score+=1.3;confirms++;reasons.push("1m MACD aligned");}

  const aroonAligned=direction==="CALL"
    ? (ar1.up>ar1.down+12)
    : (ar1.down>ar1.up+12);
  if(aroonAligned){score+=0.9;confirms++;reasons.push("1m Aroon aligned");}

  const dmiAligned=direction==="CALL"
    ? dmi.plusDI>dmi.minusDI+2
    : dmi.minusDI>dmi.plusDI+2;
  if(dmiAligned&&dmi.adx>=15){
    score+=1.0;confirms++;reasons.push("ADX/DMI aligned");
  }

  const rsiAligned=direction==="CALL"
    ? (rsi1.rsi>=49&&rsi1.rsi<=76)
    : (rsi1.rsi<=51&&rsi1.rsi>=24);
  if(rsiAligned){score+=0.7;confirms++;reasons.push("RSI(7) aligned");}

  const pressureAligned=direction==="CALL"?pressure.bull>=2:pressure.bear>=2;
  if(pressureAligned){score+=0.7;confirms++;reasons.push("1m candle pressure aligned");}

  if(regime?.ready&&regime.direction===direction){
    score+=1.0;reasons.push("5m regime aligned");
  }

  // Longer expiry permits more entry windows: core threshold stays selective,
  // but we no longer require perfect 5s/15s synchronization.
  if(score<6.0||confirms<3){
    return {ok:false,reason:`5m consensus below threshold (score ${score.toFixed(1)}, confirmations ${confirms})`,
      coreDirection:direction,score,confirms,bars15:bars15.length};
  }

  const m15=macdSnapshot(bars15,3,8,3);
  const imp=tickImpulse(ticks);
  const bullish=direction==="CALL";
  const m15Aligned=m15.ready&&(bullish?(m15.macd>m15.signal&&m15.hist>0):(m15.macd<m15.signal&&m15.hist<0));
  const impAligned=imp.ready&&(bullish?(imp.upRatio>=0.54&&imp.norm>0):(imp.downRatio>=0.54&&imp.norm<0));
  const strongOppImpulse=imp.ready&&(bullish?(imp.downRatio>=0.72&&imp.norm<0):(imp.upRatio>=0.72&&imp.norm>0));
  const b15=bars15.at(-1);
  const candleAligned=b15?((bullish&&Number(b15.c)>Number(b15.o))||(!bullish&&Number(b15.c)<Number(b15.o))):false;

  if(strongOppImpulse){
    return {ok:false,reason:"live tick impulse strongly opposes entry",coreDirection:direction,bars15:bars15.length};
  }

  // Short-term timing improves ranking, but a strong 1m/5m trend setup is not blocked
  // merely because a fresh 15s indicator window has not accumulated yet.
  const timingCount=[m15Aligned,impAligned,candleAligned].filter(Boolean).length;
  const timingScore=(m15Aligned?1.2:0)+(impAligned?1.2:0)+(candleAligned?0.6:0);

  if(timingCount===0){
    return {ok:false,reason:"5m setup exists but fresh entry timing is not aligned",coreDirection:direction,
      score,bars15:bars15.length};
  }
  const quality=clamp(
    0.65 + Math.min(score-6.0,4)*0.035 + Math.min(timingScore,3)*0.025 +
    (regime?.ready&&regime.direction===direction?0.03:0),
    0.65,0.92
  );

  return {
    ok:true,direction,expirySeconds:EXPIRY_SECONDS,quality,
    callScore:direction==="CALL"?score:0,putScore:direction==="PUT"?score:0,
    edge:score,coreMajor:confirms,microConfirmations:timingCount,microScore:timingScore,
    regimeEfficiency:regime?.efficiency??null,spreadAtrRatio,atrRatio,rsi:rsi1.rsi,adx:dmi.adx,
    smaFastPeriod:5,smaSlowPeriod:13,fractalPeriod:2,timeframe:"1min",expiryMinutes:5,
    smaFast:sma1.fast,smaSlow:sma1.slow,
    reasons:[...reasons,m15Aligned?"15s MACD aligned":null,impAligned?"live tick impulse aligned":null,candleAligned?"15s candle aligned":null].filter(Boolean),
    bars15:bars15.length,bars1m:bars1m.length,lastPrice:last
  };
}

export class TickHub extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx; this.env=env; this.ws=null; this.ticks=new Map(); this.symbols=new Set();
    this.lastStatus="starting"; this.lastSubscribeStatus=null; this.connecting=false; this.provider="tiingo";
    this.lastWsMessageAt=0; this.lastPriceReceivedAt=0; this.lastConnectAt=0; this.reconnectCount=0; this.oneMinuteCache=new Map(); this.quotaBlockedUntil=0; this.pendingSignals=[]; this.signalStats={total:0,wins:0,losses:0,draws:0,voids:0}; this.signalHistory=[];

    this.ctx.blockConcurrencyWhile(async()=>{
      // V11.2: prefer the configured warm list over old persisted symbols so a Basic/trial
      // account does not keep resubscribing to unsupported pairs from earlier builds.
      const configured=String(env.WS_SYMBOLS||DEFAULT_SYMBOLS).split(",").map(normalizeSymbol).filter(Boolean);
      for(const s of (configured.length?configured:[...DEFAULT_SYMBOLS.split(",")])) if(s) this.symbols.add(s);
      await this.ctx.storage.put("symbols",[...this.symbols]);
      const persistedContext=(await this.ctx.storage.get("oneMinuteCacheData"))||{};
      for(const [symbol,value] of Object.entries(persistedContext)){
        if(value&&Array.isArray(value.bars))this.oneMinuteCache.set(symbol,value);
      }
      this.quotaBlockedUntil=Number((await this.ctx.storage.get("tiingoQuotaBlockedUntil"))||0);
      this.pendingSignals=(await this.ctx.storage.get("pendingSignals"))||[];
      this.signalStats=(await this.ctx.storage.get("signalStats"))||{total:0,wins:0,losses:0,draws:0,voids:0};
      this.signalHistory=(await this.ctx.storage.get("signalHistory"))||[];
      await this.ensureSocket();
      await this.scheduleAlarm();
    });
  }

  latestReceivedAge(symbol){
    const arr=this.ticks.get(symbol)||[];
    if(!arr.length) return Infinity;
    const last=arr.at(-1);
    return Math.max(0,(Date.now()-Number(last.r||last.t))/1000);
  }

  latestMarketAge(symbol){
    const arr=this.ticks.get(symbol)||[];
    if(!arr.length) return Infinity;
    return Math.max(0,(Date.now()-Number(arr.at(-1).t))/1000);
  }

  async scheduleAlarm(){
    const now=Date.now();
    let next=now+10000;
    for(const p of this.pendingSignals){
      const exp=Number(p.expiresAt||0);
      if(exp>now) next=Math.min(next,exp);
      else next=Math.min(next,now+1000);
    }
    await this.ctx.storage.setAlarm(Math.max(now+250,next));
  }

  async sendTrackedResult(chatId,text){
    const token=String(this.env.TELEGRAM_BOT_TOKEN||"").trim();
    if(!token)return;
    try{
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})
      });
    }catch(_){}
  }

  async settlePendingSignals(){
    if(!this.pendingSignals.length)return;
    const now=Date.now(), keep=[], settled=[];

    for(const sig of this.pendingSignals){
      if(Number(sig.expiresAt)>now){keep.push(sig);continue;}

      const arr=this.ticks.get(sig.symbol)||[];
      const exitTick=arr.find(t=>Number(t.r||t.t)>=Number(sig.expiresAt));

      if(!exitTick){
        if(now-Number(sig.expiresAt)<15000){keep.push(sig);continue;}

        const rec={...sig,result:"VOID",exitPrice:null,settledAt:now};
        settled.push(rec);
        this.signalStats.total++;
        this.signalStats.voids++;
        await this.sendTrackedResult(
          sig.chatId,
          `RESULT — ${sig.symbol}\n${sig.direction==="CALL"?"⬆️ CALL":"⬇️ PUT"} • 5 minutes\n⚪ VOID — no fresh Tiingo tick was available at expiry`
        );
        continue;
      }

      const entry=Number(sig.entryPrice), exit=Number(exitTick.p);
      const delta=exit-entry;
      let result="DRAW";
      if(Math.abs(delta)>1e-12){
        const won=sig.direction==="CALL"?delta>0:delta<0;
        result=won?"WIN":"LOSS";
      }

      const rec={...sig,result,exitPrice:exit,exitTickAt:Number(exitTick.r||exitTick.t),settledAt:now};
      settled.push(rec);
      this.signalStats.total++;
      if(result==="WIN")this.signalStats.wins++;
      else if(result==="LOSS")this.signalStats.losses++;
      else this.signalStats.draws++;

      const mark=result==="WIN"?"✅":result==="LOSS"?"❌":"➖";
      await this.sendTrackedResult(
        sig.chatId,
        `RESULT — ${sig.symbol}\n${sig.direction==="CALL"?"⬆️ CALL":"⬇️ PUT"} • 5 minutes\nENTRY: ${formatFxPrice(sig.symbol,entry)}\nEXIT: ${formatFxPrice(sig.symbol,exit)}\n${mark} ${result}\nTRACKING: Tiingo feed`
      );
    }

    this.pendingSignals=keep;
    if(settled.length){
      this.signalHistory=[...settled,...this.signalHistory].slice(0,100);
      await this.ctx.storage.put("pendingSignals",this.pendingSignals);
      await this.ctx.storage.put("signalStats",this.signalStats);
      await this.ctx.storage.put("signalHistory",this.signalHistory);
    }else if(keep.length!==this.pendingSignals.length){
      await this.ctx.storage.put("pendingSignals",this.pendingSignals);
    }
  }

  async alarm(){
    try{
      await this.ensureSocket();

      if(this.ws&&this.ws.readyState===1){
        const msgAge=this.lastWsMessageAt?((Date.now()-this.lastWsMessageAt)/1000):Infinity;
        if(msgAge>45) await this.forceReconnect("no websocket messages for >45s");
      }else{
        await this.forceReconnect("socket not open");
      }

      await this.settlePendingSignals();
    }catch(e){
      this.lastStatus=`alarm error: ${String(e?.message||e)}`;
    }
    await this.scheduleAlarm();
  }

  async forceReconnect(reason="manual reconnect"){
    this.reconnectCount++;
    this.lastStatus=`reconnecting: ${reason}`;
    try{
      if(this.ws){
        try{ this.ws.close(1000,"reconnect"); }catch(_){}
      }
    }catch(_){}
    this.ws=null;
    this.connecting=false;
    await sleep(150);
    await this.ensureSocket(true);
  }

  async ensureSocket(force=false){
    if(!force && this.ws&&this.ws.readyState===1)return;
    if(this.connecting)return;

    const key=String(this.env.TIINGO_API_TOKEN||"").trim();
    if(!key){this.lastStatus="missing TIINGO_API_TOKEN";return;}

    this.connecting=true;
    try{
      const ws=new WebSocket("wss://api.tiingo.com/fx");
      this.ws=ws;

      ws.addEventListener("open",()=>{
        this.connecting=false;
        this.lastConnectAt=Date.now();
        this.lastWsMessageAt=Date.now();
        this.lastStatus="connected";

        const tickers=[...this.symbols].map(toTiingoSymbol).filter(Boolean);
        ws.send(JSON.stringify({
          eventName:"subscribe",
          authorization:key,
          eventData:{
            thresholdLevel:5,
            tickers
          }
        }));
      });

      ws.addEventListener("message",ev=>this.onMessage(ev));

      ws.addEventListener("close",()=>{
        if(this.ws===ws)this.ws=null;
        this.connecting=false;
        this.lastStatus="closed";
      });

      ws.addEventListener("error",()=>{
        this.lastStatus="tiingo websocket error";
      });
    }catch(e){
      this.connecting=false;
      this.ws=null;
      this.lastStatus=String(e?.message||e);
    }
  }

  onMessage(ev){
    this.lastWsMessageAt=Date.now();
    try{
      const x=JSON.parse(String(ev.data||"{}"));

      if(x.messageType==="I"){
        this.lastSubscribeStatus=x;
        this.lastStatus=x?.response?.message||"subscribed";
        return;
      }
      if(x.messageType==="H"){
        if(this.lastStatus==="closed"||this.lastStatus.startsWith("reconnecting"))this.lastStatus="connected";
        return;
      }
      if(x.messageType==="E"){
        this.lastSubscribeStatus=x;
        this.lastStatus=`tiingo error: ${x?.response?.message||"subscription error"}`;
        return;
      }
      if(x.messageType!=="A"||x.service!=="fx"||!Array.isArray(x.data))return;

      const d=x.data;
      if(d[0]!=="Q")return;

      const symbol=fromTiingoSymbol(d[1]);
      const t=Date.parse(String(d[2]||""));
      const bid=Number(d[4]), mid=Number(d[5]), ask=Number(d[7]);
      const p=Number.isFinite(mid)?mid:(Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:NaN);
      const r=Date.now();

      if(!symbol||!Number.isFinite(p)||!Number.isFinite(t))return;
      if(!this.symbols.has(symbol))return;

      this.lastPriceReceivedAt=r;
      this.lastStatus="ok";
      const arr=this.ticks.get(symbol)||[];
      arr.push({t,p,r,bid:Number.isFinite(bid)?bid:null,ask:Number.isFinite(ask)?ask:null});

      const cutoff=Date.now()-45*60*1000;
      while(arr.length&&Number(arr[0].r||arr[0].t)<cutoff)arr.shift();
      if(arr.length>20000)arr.splice(0,arr.length-20000);
      this.ticks.set(symbol,arr);
    }catch(e){
      this.lastStatus=`tiingo parse error: ${String(e?.message||e)}`;
    }
  }

  async subscribe(symbol){
    symbol=normalizeSymbol(symbol);
    if(!symbol)return false;
    if(!FIXED_UNIVERSE.includes(symbol))return false;

    if(!this.symbols.has(symbol)){
      this.symbols.add(symbol);
      await this.ctx.storage.put("symbols",[...this.symbols]);
      // Tiingo subscriptions are established from the complete ticker set at connect time.
      await this.forceReconnect("ticker universe changed");
    }else{
      await this.ensureSocket();
    }
    return true;
  }

  async refreshIfStale(symbol){
    const receiveAge=this.latestReceivedAge(symbol);
    const msgAge=this.lastWsMessageAt?Math.max(0,(Date.now()-this.lastWsMessageAt)/1000):Infinity;

    // A never-seen symbol may simply be unsupported by the current Tiingo plan.
    // Do not tear down the healthy socket for the other five symbols just because this pair has no ticks yet.
    if(!Number.isFinite(receiveAge)){
      await this.ensureSocket();
      return;
    }

    if(receiveAge>15 || msgAge>45 || !(this.ws&&this.ws.readyState===1)){
      await this.forceReconnect(`stale ${symbol} feed`);
      await sleep(1800);
    }
  }

  async persistOneMinuteCache(){
    const out={};
    for(const [symbol,value] of this.oneMinuteCache.entries())out[symbol]=value;
    await this.ctx.storage.put("oneMinuteCacheData",out);
  }

  mergeOneMinuteContext(symbol,cachedBars=[]){
    const currentMinute=Math.floor(Date.now()/60000)*60000;
    const liveBars=buildBars(this.ticks.get(symbol)||[],60).filter(b=>b.t<currentMinute);
    const merged=new Map();
    for(const b of cachedBars||[])merged.set(Number(b.t),b);
    for(const b of liveBars)merged.set(Number(b.t),b);
    return [...merged.values()].sort((a,b)=>a.t-b.t).slice(-80);
  }

  contextIsUsable(bars){
    if(!Array.isArray(bars)||bars.length<24)return false;
    const xs=bars.slice(-24);
    const last=xs.at(-1);
    if(!last||Date.now()-Number(last.t)>3*60*1000)return false;
    // Reject a context window with a large missing-data gap.
    for(let i=1;i<xs.length;i++){
      if(Number(xs[i].t)-Number(xs[i-1].t)>3*60*1000)return false;
    }
    return true;
  }

  quotaRetryMinutes(){
    const left=Math.max(0,this.quotaBlockedUntil-Date.now());
    return Math.max(1,Math.ceil(left/60000));
  }

  async fetchOneMinuteBars(symbol){
    const cached=this.oneMinuteCache.get(symbol);
    const merged=this.mergeOneMinuteContext(symbol,cached?.bars||[]);

    // Once bootstrapped, use the real-time Tiingo stream to keep 1m context current.
    // This avoids spending a REST request on every /signal scan.
    if(this.contextIsUsable(merged)){
      if(!cached||merged.at(-1)?.t!==cached.bars?.at(-1)?.t){
        this.oneMinuteCache.set(symbol,{at:Date.now(),bars:merged});
      }
      return merged;
    }

    if(this.quotaBlockedUntil>Date.now()){
      const e=new Error("Tiingo hourly request quota is temporarily exhausted");
      e.quotaExceeded=true;
      e.retryAfterMinutes=this.quotaRetryMinutes();
      throw e;
    }

    const key=String(this.env.TIINGO_API_TOKEN||"").trim();
    if(!key)throw new Error("missing TIINGO_API_TOKEN");

    const ticker=toTiingoSymbol(symbol);
    if(!ticker)throw new Error("invalid Tiingo FX ticker");

    const start=new Date(Date.now()-24*60*60*1000).toISOString().slice(0,10);
    const u=new URL(`https://api.tiingo.com/tiingo/fx/${ticker}/prices`);
    u.searchParams.set("startDate",start);
    u.searchParams.set("resampleFreq","1min");

    const res=await fetch(u.toString(),{
      headers:{accept:"application/json",authorization:`Token ${key}`}
    });

    let data;
    try{data=await res.json();}catch(_){data=null;}

    if(!res.ok||!Array.isArray(data)){
      const msg=String(data?.detail||data?.message||`Tiingo 1m context request failed (${res.status})`);
      if(/hourly request allocation|hourly.*limit|request.*hour/i.test(msg)){
        // Tiingo documents hourly request limits as resetting every hour.
        // Add a one-minute buffer beyond the next clock-hour boundary.
        this.quotaBlockedUntil=(Math.floor(Date.now()/3600000)+1)*3600000+60000;
        await this.ctx.storage.put("tiingoQuotaBlockedUntil",this.quotaBlockedUntil);
        const e=new Error("Tiingo hourly request quota is temporarily exhausted");
        e.quotaExceeded=true;
        e.retryAfterMinutes=this.quotaRetryMinutes();
        throw e;
      }
      throw new Error(msg);
    }

    const currentMinute=Math.floor(Date.now()/60000)*60000;
    const restBars=data.map(v=>({
      t:Date.parse(String(v.date||"")),
      o:Number(v.open),h:Number(v.high),l:Number(v.low),c:Number(v.close),n:1
    })).filter(b=>Number.isFinite(b.t)&&[b.o,b.h,b.l,b.c].every(Number.isFinite)&&b.t<currentMinute)
      .sort((a,b)=>a.t-b.t)
      .slice(-80);

    if(restBars.length<24)throw new Error(`only ${restBars.length} completed Tiingo 1m bars available`);

    const fresh=this.mergeOneMinuteContext(symbol,restBars);
    this.oneMinuteCache.set(symbol,{at:Date.now(),bars:fresh});
    this.quotaBlockedUntil=0;
    await this.ctx.storage.delete("tiingoQuotaBlockedUntil");
    await this.persistOneMinuteCache();
    return fresh;
  }

  async analyze(symbol){
    symbol=normalizeSymbol(symbol); if(!symbol)return {ok:false,error:"invalid symbol"};
    const pairWait=this.pairCooldownSeconds(symbol);
    if(pairWait>0)return {ok:false,cooldown:true,retrySeconds:pairWait,symbol,reason:"pair precision cooldown"};
    await this.subscribe(symbol); await this.ensureSocket(); await this.refreshIfStale(symbol);

    let arr=this.ticks.get(symbol)||[];
    if(arr.length<24){await sleep(1500);arr=this.ticks.get(symbol)||[];}

    const receiveAge=arr.length?this.latestReceivedAge(symbol):Infinity;
    const marketAge=arr.length?this.latestMarketAge(symbol):Infinity;
    const bars15=buildBars(arr,15).length;

    const bars5=buildBars(arr,5).length;
    if(!arr.length){
      return {ok:false,warming:true,symbol,ticks:0,bars15:0,bars5:0,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,reason:"waiting for first live Tiingo quote"};
    }
    if(receiveAge>8){
      return {ok:false,symbol,ticks:arr.length,bars15,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,reason:`live feed stale: no received tick for ${receiveAge.toFixed(1)}s`};
    }
    if(marketAge>10){
      return {ok:false,symbol,ticks:arr.length,bars15,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,reason:`Tiingo quote timestamp is ${marketAge.toFixed(1)}s behind live time`};
    }

    let bars1m;
    try{bars1m=await this.fetchOneMinuteBars(symbol);}
    catch(e){
      if(e?.quotaExceeded){
        return {ok:false,quotaExceeded:true,retryAfterMinutes:Number(e.retryAfterMinutes)||1,symbol,ticks:arr.length,bars15,
          receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,status:this.lastStatus,
          reason:"Tiingo hourly request quota is temporarily exhausted"};
      }
      return {ok:false,symbol,ticks:arr.length,bars15,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,reason:`1m context unavailable: ${String(e?.message||e)}`};
    }

    const x=score5m(arr,bars1m);
    if(!x.ok)return {...x,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,status:this.lastStatus};
    return {...x,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
      status:this.lastStatus,reconnectCount:this.reconnectCount,generatedAt:Date.now()};
  }

  isCurrentStrategyRecord(record){
    if(!record)return false;
    if(record.strategyId)return record.strategyId===STRATEGY_ID;
    const entry=Number(record.entryAt||0), expiry=Number(record.expiresAt||0);
    const inferredSeconds=entry&&expiry?Math.round((expiry-entry)/1000):0;
    return inferredSeconds===EXPIRY_SECONDS;
  }

  getRiskGate(){
    const now=Date.now();
    const pending=this.pendingSignals.filter(x=>this.isCurrentStrategyRecord(x)).sort((a,b)=>Number(b.entryAt)-Number(a.entryAt));
    if(pending.length){
      const latest=pending[0];
      const retryMs=Math.max(1000,Number(latest.expiresAt||now)-now+30000);
      return {ok:false,reason:"an existing signal is still being settled",retrySeconds:Math.ceil(retryMs/1000)};
    }

    const hist=this.signalHistory.filter(x=>this.isCurrentStrategyRecord(x)).sort((a,b)=>Number(b.settledAt||b.entryAt)-Number(a.settledAt||a.entryAt));
    const latest=hist[0];
    if(latest){
      const sinceEntry=now-Number(latest.entryAt||0);
      if(sinceEntry<GLOBAL_SIGNAL_COOLDOWN_MS){
        return {ok:false,reason:"global precision cooldown",retrySeconds:Math.ceil((GLOBAL_SIGNAL_COOLDOWN_MS-sinceEntry)/1000)};
      }
    }

    const resolved=hist.filter(x=>x.result==="WIN"||x.result==="LOSS");
    if(resolved.length>=2&&resolved[0].result==="LOSS"&&resolved[1].result==="LOSS"){
      const sinceLatest=now-Number(resolved[0].settledAt||resolved[0].entryAt||0);
      if(sinceLatest<LOSS_CIRCUIT_BREAKER_MS){
        return {ok:false,reason:"two-loss circuit breaker",retrySeconds:Math.ceil((LOSS_CIRCUIT_BREAKER_MS-sinceLatest)/1000)};
      }
    }

    // If the last three resolved trades contain two or more losses, cool down globally for 10 minutes.
    const last3=resolved.slice(0,3);
    if(last3.length===3&&last3.filter(x=>x.result==="LOSS").length>=2){
      const sinceLatest=now-Number(last3[0].settledAt||last3[0].entryAt||0);
      const adaptive=10*60*1000;
      if(sinceLatest<adaptive){
        return {ok:false,reason:"recent performance cooldown",retrySeconds:Math.ceil((adaptive-sinceLatest)/1000)};
      }
    }

    return {ok:true};
  }

  pairCooldownSeconds(symbol){
    const now=Date.now();
    const all=[...this.pendingSignals,...this.signalHistory]
      .filter(x=>x.symbol===symbol&&this.isCurrentStrategyRecord(x))
      .sort((a,b)=>Number(b.entryAt)-Number(a.entryAt));
    const latest=all[0];
    if(!latest)return 0;

    const resolved=all.filter(x=>x.result==="WIN"||x.result==="LOSS");
    if(resolved.length>=2&&resolved[0].result==="LOSS"&&resolved[1].result==="LOSS"){
      const left=30*60*1000-(now-Number(resolved[0].settledAt||resolved[0].entryAt||0));
      if(left>0)return Math.ceil(left/1000);
    }
    if(resolved[0]?.result==="LOSS"){
      const left=12*60*1000-(now-Number(resolved[0].settledAt||resolved[0].entryAt||0));
      if(left>0)return Math.ceil(left/1000);
    }

    const left=PAIR_SIGNAL_COOLDOWN_MS-(now-Number(latest.entryAt||0));
    return left>0?Math.ceil(left/1000):0;
  }

  async trackSignal(req){
    const body=await req.json();
    const symbol=normalizeSymbol(body?.symbol);
    const direction=String(body?.direction||"").toUpperCase();
    const entryPrice=Number(body?.entryPrice);
    const chatId=body?.chatId;
    const sourceUpdateId=String(body?.sourceUpdateId??"");
    const entryAt=Number(body?.entryAt)||Date.now();

    if(!symbol||!FIXED_UNIVERSE.includes(symbol))return {ok:false,error:"invalid symbol"};
    if(!["CALL","PUT"].includes(direction))return {ok:false,error:"invalid direction"};
    if(!Number.isFinite(entryPrice)||!chatId)return {ok:false,error:"invalid tracking payload"};

    if(sourceUpdateId){
      const duplicate=this.pendingSignals.find(x=>String(x.sourceUpdateId)===sourceUpdateId)||
        this.signalHistory.find(x=>String(x.sourceUpdateId)===sourceUpdateId);
      if(duplicate)return {ok:true,duplicate:true,id:duplicate.id};
    }

    const sig={
      id:crypto.randomUUID(),
      sourceUpdateId,
      chatId,
      symbol,
      direction,
      entryPrice,
      entryAt,
      expiresAt:entryAt+EXPIRY_SECONDS*1000,
      expirySeconds:EXPIRY_SECONDS,
      strategyId:STRATEGY_ID,
      version:VERSION
    };
    this.pendingSignals.push(sig);
    await this.ctx.storage.put("pendingSignals",this.pendingSignals);
    await this.scheduleAlarm();
    return {ok:true,id:sig.id,expiresAt:sig.expiresAt};
  }

  async getTrackingStats(){
    const current=this.signalHistory.filter(x=>this.isCurrentStrategyRecord(x));
    const wins=current.filter(x=>x.result==="WIN").length;
    const losses=current.filter(x=>x.result==="LOSS").length;
    const draws=current.filter(x=>x.result==="DRAW").length;
    const voids=current.filter(x=>x.result==="VOID").length;
    const resolved=wins+losses;
    const winRate=resolved>0?(wins/resolved)*100:null;
    const pending=this.pendingSignals.filter(x=>this.isCurrentStrategyRecord(x)).length;
    return {
      ok:true,
      strategyId:STRATEGY_ID,
      expirySeconds:EXPIRY_SECONDS,
      total:current.length,
      wins,losses,draws,voids,pending,winRate,
      recent:current.slice(0,5),
      allTime:{...this.signalStats}
    };
  }

    async fetch(req){
    const u=new URL(req.url), symbol=normalizeSymbol(u.searchParams.get("symbol")||"");

    if(u.pathname==="/reconnect"){
      await this.forceReconnect("requested");
      return json({ok:true,version:VERSION,status:this.lastStatus,reconnectCount:this.reconnectCount});
    }

    if(u.pathname==="/signal")return json(await this.analyze(symbol));
    if(u.pathname==="/quote"){
      if(!symbol)return json({ok:false,error:"invalid symbol"},400);
      await this.subscribe(symbol);
      await this.ensureSocket();
      const arr=this.ticks.get(symbol)||[];
      const q=arr.at(-1);
      if(!q)return json({ok:false,symbol,error:"no live quote"});
      return json({
        ok:true,
        symbol,
        price:Number(q.p),
        bid:q.bid,
        ask:q.ask,
        providerAt:Number(q.t),
        receivedAt:Number(q.r||q.t),
        receiveAgeSeconds:this.latestReceivedAge(symbol),
        marketAgeSeconds:this.latestMarketAge(symbol)
      });
    }
    if(u.pathname==="/risk")return json(this.getRiskGate());
    if(u.pathname==="/track"&&req.method==="POST")return json(await this.trackSignal(req));
    if(u.pathname==="/stats")return json(await this.getTrackingStats());

    if(u.pathname==="/status"){
      if(symbol) await this.subscribe(symbol);

      // Status calls also heal a stale socket, but do not wait long enough to hide the diagnosis.
      if(symbol && Number.isFinite(this.latestReceivedAge(symbol)) && this.latestReceivedAge(symbol)>30) {
        try{ await this.forceReconnect(`status detected stale ${symbol}`); }catch(_){}
      } else {
        await this.ensureSocket();
      }

      const arr=symbol?(this.ticks.get(symbol)||[]):[];
      const lastMessageAge=this.lastWsMessageAt?Math.max(0,(Date.now()-this.lastWsMessageAt)/1000):null;

      return json({
        version:VERSION,
        provider:this.provider,
        status:this.lastStatus,
        subscribeStatus:this.lastSubscribeStatus,
        connected:Boolean(this.ws&&this.ws.readyState===1),
        symbols:[...this.symbols],
        symbol,
        ticks:arr.length,
        bars5:buildBars(arr,5).length,
        bars15:buildBars(arr,15).length,
        lastTickAgeSeconds:arr.length?this.latestReceivedAge(symbol):null,
        providerTickAgeSeconds:arr.length?this.latestMarketAge(symbol):null,
        lastWsMessageAgeSeconds:lastMessageAge,
        reconnectCount:this.reconnectCount,
        expirySeconds:EXPIRY_SECONDS
      });
    }

    return json({ok:true,version:VERSION,expirySeconds:EXPIRY_SECONDS});
  }
}

async function tgSend(env,chatId,text,replyMarkup=null){
  const token=String(env.TELEGRAM_BOT_TOKEN||"").trim();
  if(!token)throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const body={chat_id:chatId,text,disable_web_page_preview:true};
  body.reply_markup=replyMarkup||{remove_keyboard:true};
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body)
  });
  const data=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(`Telegram ${r.status}: ${JSON.stringify(data)||"send failed"}`);
  return data?.result||null;
}
function parseSignalText(text){
  const t=String(text||"").trim();
  const m=t.match(/^\/signal(?:\s+(.+))?$/i); if(m)return normalizeSymbol(m[1]||"");
  return normalizeSymbol(t);
}
async function hub(env,path){
  const id=env.TICK_HUB.idFromName("global-market-feed"), stub=env.TICK_HUB.get(id);
  const r=await stub.fetch(`https://tickhub${path}`); return await r.json();
}
async function hubPost(env,path,body){
  const id=env.TICK_HUB.idFromName("global-market-feed"), stub=env.TICK_HUB.get(id);
  const r=await stub.fetch(`https://tickhub${path}`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body)
  });
  return await r.json();
}


async function scanSixPairUniverse(env){
  const checked=[];
  for(const symbol of FIXED_UNIVERSE){
    try{
      const r=await hub(env,`/signal?symbol=${encodeURIComponent(symbol)}`);
      checked.push({...r,symbol});
      if(r?.quotaExceeded){
        return {
          ok:false,
          quotaExceeded:true,
          retryAfterMinutes:Number(r.retryAfterMinutes)||1,
          checked,
          reason:"Tiingo hourly request quota is temporarily exhausted."
        };
      }
    }catch(e){
      checked.push({ok:false,symbol,reason:String(e?.message||e)});
    }
  }

  const qualified=checked.filter(x=>x?.ok&&x?.direction&&Number.isFinite(Number(x.quality)));
  qualified.sort((a,b)=>
    Number(b.quality||0)-Number(a.quality||0) ||
    Number(b.edge||0)-Number(a.edge||0) ||
    Number(b.microConfirmations||0)-Number(a.microConfirmations||0)
  );

  if(!qualified.length){
    return {ok:false,checked,reason:"No qualified 5-minute entry across the fixed six-pair universe."};
  }
  return {ok:true,best:qualified[0],checked};
}


async function checkAllFeeds(env){
  const results=await Promise.all(FIXED_UNIVERSE.map(async symbol=>{
    try{
      const st=await hub(env,`/status?symbol=${encodeURIComponent(symbol)}`);
      const ticks=Number(st.ticks||0);
      const received=st.lastTickAgeSeconds==null?null:Number(st.lastTickAgeSeconds);
      const provider=st.providerTickAgeSeconds==null?null:Number(st.providerTickAgeSeconds);

      let health="NO DATA";
      if(st.connected && ticks>0 && Number.isFinite(received) && Number.isFinite(provider)){
        if(received<=8 && provider<=10) health="LIVE";
        else if(received<=20 && provider<=30) health="WARMING";
        else health="STALE";
      }else if(st.connected){
        health="WARMING";
      }

      return {
        symbol,
        health,
        connected:Boolean(st.connected),
        ticks,
        receivedAge:Number.isFinite(received)?received:null,
        providerAge:Number.isFinite(provider)?provider:null,
        status:st.status||"n/a"
      };
    }catch(e){
      return {
        symbol,
        health:"ERROR",
        connected:false,
        ticks:0,
        receivedAge:null,
        providerAge:null,
        status:String(e?.message||e)
      };
    }
  }));
  return results;
}


export default {
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(u.pathname==="/health")return json({ok:true,version:VERSION,expirySeconds:EXPIRY_SECONDS});
    if(u.pathname==="/feed"){
      const s=normalizeSymbol(u.searchParams.get("symbol")||"EUR/USD")||"EUR/USD";
      return json(await hub(env,`/status?symbol=${encodeURIComponent(s)}`));
    }
    if(request.method!=="POST")return new Response("V11.9 revalidated five-minute scanner",{status:200});
    if(u.pathname!=="/telegram")return new Response("Not found",{status:404});
    const secret=String(env.TELEGRAM_WEBHOOK_SECRET||"").trim();
    if(secret&&request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==secret)return new Response("forbidden",{status:403});
    const update=await request.json(); const msg=update.message||update.edited_message; if(!msg?.chat?.id)return new Response("ok");
    const chatId=msg.chat.id, text=String(msg.text||"").trim();
    if(/^\/version$/i.test(text)){await tgSend(env,chatId,VERSION);return new Response("ok");}
    if(/^\/start$/i.test(text)){
      await tgSend(
        env,
        chatId,
        "V11.9 — REVALIDATED 5-MINUTE MODE. Uses completed 5m regime candles, rejects stretched entries, requires fresh timing confirmation, rechecks the selected pair immediately before sending, and starts tracking from a fresh Tiingo quote after Telegram delivery."
      );
      return new Response("ok");
    }
    if(/^\/checkall$/i.test(text)){
      const rows=await checkAllFeeds(env);
      const icon=h=>h==="LIVE"?"🟢":h==="WARMING"?"🟡":h==="STALE"?"🔴":h==="ERROR"?"❌":"⚪";
      const lines=rows.map(r=>{
        const rx=r.receivedAge==null?"n/a":r.receivedAge.toFixed(1)+"s";
        const px=r.providerAge==null?"n/a":r.providerAge.toFixed(1)+"s";
        return `${icon(r.health)} ${r.symbol} — ${r.health}\nTicks: ${r.ticks} • Rx: ${rx} • Px: ${px}`;
      });
      const liveCount=rows.filter(r=>r.health==="LIVE").length;
      await tgSend(
        env,
        chatId,
        `SIX-PAIR FEED HEALTH\nLIVE: ${liveCount}/${FIXED_UNIVERSE.length}\n\n${lines.join("\n\n")}`
      );
      return new Response("ok");
    }
    if(/^\/stats$/i.test(text)){
      const st=await hub(env,"/stats");
      const wr=st.winRate==null?"n/a":Number(st.winRate).toFixed(1)+"%";
      await tgSend(
        env,
        chatId,
        `TRACKED SIGNAL STATS\nTotal settled: ${st.total||0}\nWins: ${st.wins||0}\nLosses: ${st.losses||0}\nDraws: ${st.draws||0}\nVoids: ${st.voids||0}\nPending: ${st.pending||0}\nWin rate (W/L only): ${wr}\n\nResults are measured from Tiingo prices, not Pocket Option settlement prices.`
      );
      return new Response("ok");
    }
    if(/^\/diagnose$/i.test(text)){
      const rows=[];
      for(const symbol of FIXED_UNIVERSE){
        try{
          const r=await hub(env,`/signal?symbol=${encodeURIComponent(symbol)}`);
          rows.push(`${symbol}: ${r.ok?"QUALIFIED":(r.reason||"not ready")}`);
        }catch(e){
          rows.push(`${symbol}: error`);
        }
      }
      await tgSend(env,chatId,`SIGNAL DIAGNOSIS\n\n${rows.join("\n")}`);
      return new Response("ok");
    }
    if(/^\/reconnect$/i.test(text)){
      const st=await hub(env,"/reconnect");
      await tgSend(env,chatId,`FEED RECONNECT REQUESTED\nSTATUS: ${st.status||"n/a"}\nRECONNECTS: ${st.reconnectCount||0}`);
      return new Response("ok");
    }
    if(/^\/feed/i.test(text)){
      const s=normalizeSymbol(text.replace(/^\/feed\s*/i,""))||"EUR/USD";
      const st=await hub(env,`/status?symbol=${encodeURIComponent(s)}`);
      await tgSend(env,chatId,
        `FEED ${s}\n`+
        `PROVIDER: ${st.provider||"tiingo"}\n`+
        `CONNECTED: ${st.connected?"YES":"NO"}\n`+
        `TICKS: ${st.ticks||0}\n`+
        `5s BARS: ${st.bars5||0}\n`+
        `15s BARS: ${st.bars15||0}\n`+
        `RECEIVED TICK AGE: ${st.lastTickAgeSeconds??"n/a"}s\n`+
        `PROVIDER TICK AGE: ${st.providerTickAgeSeconds??"n/a"}s\n`+
        `WS MESSAGE AGE: ${st.lastWsMessageAgeSeconds??"n/a"}s\n`+
        `RECONNECTS: ${st.reconnectCount||0}\n`+
        `EXPIRY: 300s\n`+
        `STATUS: ${st.status||"n/a"}\n`+
        `SUBSCRIBE: ${st.subscribeStatus?.response?.message||st.subscribeStatus?.status||"n/a"}`
      );
      return new Response("ok");
    }
    const isUniverseScan=/^\/signal\s*$/i.test(text);
    if(isUniverseScan){
      const risk=await hub(env,"/risk");
      if(!risk.ok){
        const mins=Math.max(1,Math.ceil(Number(risk.retrySeconds||60)/60));
        await tgSend(
          env,
          chatId,
          `🛡️ 5-MINUTE MODE PAUSED\n${risk.reason}.\nTry /signal again in about ${mins} minute${mins===1?"":"s"}.`
        );
        return new Response("ok");
      }

      const scan=await scanSixPairUniverse(env);
      if(!scan.ok){
        if(scan.quotaExceeded){
          const mins=Math.max(1,Number(scan.retryAfterMinutes)||1);
          await tgSend(
            env,
            chatId,
            `⏳ DATA LIMIT REACHED\nTry /signal again in about ${mins} minute${mins===1?"":"s"}.\nThe bot will scan all 6 pairs again and will only issue a trade if a qualified setup is present.`
          );
          return new Response("ok");
        }

        const checked=scan.checked||[];
        const warming=checked.filter(x=>x?.warming);
        if(checked.length&&warming.length===checked.length){
          await tgSend(
            env,
            chatId,
            "⏳ LIVE FEED STARTING\nNo live Tiingo quote is available yet for the six-pair scan. Try /signal again in about 1 minute."
          );
          return new Response("ok");
        }

        await tgSend(
          env,
          chatId,
          "⏳ NO QUALIFIED 5-MINUTE SETUP RIGHT NOW\nThe live feeds are active, but none of the 6 pairs currently meets the 5-minute entry rules. Try /signal again in about 2 minutes."
        );
        return new Response("ok");
      }

      const candidate=scan.best, symbol=candidate.symbol;
      const result=await hub(env,`/signal?symbol=${encodeURIComponent(symbol)}`);
      if(!result.ok||result.direction!==candidate.direction){
        await tgSend(
          env,
          chatId,
          "⏳ SETUP CHANGED DURING FINAL CHECK\nThe best candidate no longer meets the 5-minute entry rules. Run /signal again."
        );
        return new Response("ok");
      }

      const arrow=result.direction==="CALL"?"⬆️":"⬇️";
      const compact=String(env.BOT_COMPACT_MODE??"1")!=="0";
      const sent=compact
        ? await tgSend(env,chatId,`${arrow} ${symbol}\nEXPIRY: 5 minutes\nTRACKING: ON`)
        : await tgSend(env,chatId,`${arrow} ${symbol}\nEXPIRY: 5 minutes\nSETUP QUALITY: ${(Number(result.quality)*100).toFixed(1)}%\nCALL SCORE: ${Number(result.callScore).toFixed(1)}\nPUT SCORE: ${Number(result.putScore).toFixed(1)}\nENTRY CONFIRMATIONS: ${result.microConfirmations}\nTRACKING: ON`);

      const quote=await hub(env,`/quote?symbol=${encodeURIComponent(symbol)}`);
      if(quote.ok&&Number.isFinite(Number(quote.price))){
        await hubPost(env,"/track",{
          sourceUpdateId:update.update_id,
          chatId,
          symbol,
          direction:result.direction,
          entryPrice:Number(quote.price),
          entryAt:Date.now(),
          telegramMessageDate:sent?.date||null
        });
      }
      return new Response("ok");
    }

    if(/^\/signal\b/i.test(text)){
      await tgSend(env,chatId,"Use /signal by itself. The bot scans all 6 pairs automatically and returns the strongest qualified 5-minute setup.");
      return new Response("ok");
    }

    return new Response("ok");
  }
};
