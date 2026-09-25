// V11.1 — 15-second tick sniper with Cloudflare Durable Object
import { DurableObject } from "cloudflare:workers";

const VERSION = "12.0.1-adaptive-spread";
const DEFAULT_SYMBOLS = "EUR/USD,USD/JPY,GBP/USD,USD/CAD,AUD/USD,USD/CHF,XAU/USD,BTC/USD";
const FIXED_UNIVERSE = DEFAULT_SYMBOLS.split(",");
const CRYPTO_SYMBOLS = new Set(["BTC/USD"]);
const A_GRADE_MIN_QUALITY = 0.86;
const EXPIRY_SECONDS = 300;
const STRATEGY_ID = "v12-a-grade-5m";
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
  const s=String(symbol||"");
  if(s==="BTC/USD")return n.toFixed(2);
  if(s==="XAU/USD")return n.toFixed(2);
  return n.toFixed(s.endsWith("/JPY")?3:5);
}
function isCryptoSymbol(symbol){ return CRYPTO_SYMBOLS.has(normalizeSymbol(symbol)); }
function medianNumber(xs){
  const a=(xs||[]).filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return NaN;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function spreadQualitySnapshot(symbol,ticks,last,atr){
  const now=Date.now(), cutoff=now-60000;
  const spreads=(ticks||[])
    .filter(t=>Number(t.r||t.t)>=cutoff)
    .map(t=>{
      const bid=Number(t.bid), ask=Number(t.ask);
      return Number.isFinite(bid)&&Number.isFinite(ask)&&ask>=bid ? ask-bid : NaN;
    })
    .filter(Number.isFinite)
    .slice(-60);

  const spread=medianNumber(spreads);
  if(!Number.isFinite(spread)||spread<=0||!Number.isFinite(last)||last<=0){
    return {ready:false,abnormal:false,spread:null,spreadBps:null,spreadAtrRatio:null,samples:spreads.length};
  }

  const spreadBps=(spread/last)*10000;
  const spreadAtrRatio=Number.isFinite(atr)&&atr>0?spread/atr:null;
  const s=normalizeSymbol(symbol);

  // Tiingo is our market-data reference, not the user's execution venue.
  // Spread is therefore a sanity veto only for clearly abnormal conditions,
  // not a hard filter on ordinary quote differences.
  let maxBps=3.5, softBps=1.0, maxAtr=0.65;
  if(s==="XAU/USD"){maxBps=5.0;softBps=1.5;maxAtr=0.75;}
  if(s==="BTC/USD"){maxBps=12.0;softBps=2.5;maxAtr=0.90;}

  const extremeAbsolute=spreadBps>maxBps;
  const extremeRelative=Number.isFinite(spreadAtrRatio)&&spreadAtrRatio>maxAtr&&spreadBps>softBps;
  return {
    ready:true,
    abnormal:extremeAbsolute||extremeRelative,
    spread,spreadBps,spreadAtrRatio,samples:spreads.length,
    maxBps,maxAtr
  };
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

function completedAggregate(bars1m,seconds){
  const nowBucket=Math.floor(Date.now()/(seconds*1000))*(seconds*1000);
  return aggregateOhlcBars(bars1m,seconds).filter(b=>Number(b.t)<nowBucket);
}
function trendRegime(bars,fast=5,slow=13,minEfficiency=0.25){
  if(!bars||bars.length<slow+3)return {ready:false,direction:"NEUTRAL",efficiency:0};
  const c=bars.map(b=>Number(b.c)), sf=smaSeries(c,fast), ss=smaSeries(c,slow), i=c.length-1;
  if(![sf[i],sf[i-1],ss[i],ss[i-1]].every(Number.isFinite))return {ready:false,direction:"NEUTRAL",efficiency:0};
  const eff=efficiencyRatio(bars,Math.min(8,bars.length-1));
  let direction="NEUTRAL";
  if(sf[i]>ss[i]&&sf[i]>=sf[i-1]&&eff>=minEfficiency)direction="CALL";
  if(sf[i]<ss[i]&&sf[i]<=sf[i-1]&&eff>=minEfficiency)direction="PUT";
  return {ready:true,direction,efficiency:eff,fast:sf[i],slow:ss[i]};
}
function roomToMoveSnapshot(bars1m,last,direction,atr){
  const b15=completedAggregate(bars1m,900).slice(-24);
  if(b15.length<6||!Number.isFinite(atr)||atr<=0)return {ready:false,roomAtr:0};
  if(direction==="CALL"){
    const levels=b15.map(b=>Number(b.h)).filter(x=>Number.isFinite(x)&&x>last);
    if(!levels.length)return {ready:true,roomAtr:Infinity,level:null};
    const level=Math.min(...levels);
    return {ready:true,roomAtr:(level-last)/atr,level};
  }
  const levels=b15.map(b=>Number(b.l)).filter(x=>Number.isFinite(x)&&x<last);
  if(!levels.length)return {ready:true,roomAtr:Infinity,level:null};
  const level=Math.max(...levels);
  return {ready:true,roomAtr:(last-level)/atr,level};
}

function score5m(ticks,bars1m,symbol){
  const sma1=smaTrendSnapshot(bars1m,5,13);
  const fr1=fractalSnapshot(bars1m,2);
  const m1=macdSnapshot(bars1m,5,13,4);
  const ar1=aroonSnapshot(bars1m,14);
  const atr1=atrSnapshot(bars1m,14);
  const rsi1=rsiSnapshot(bars1m,7);
  const dmi=dmiAdxSnapshot(bars1m,7);
  const pressure=candlePressure(bars1m,3);
  const b5=completedAggregate(bars1m,300);
  const b15=completedAggregate(bars1m,900);
  const regime5=trendRegime(b5,5,13,0.24);
  const regime15=trendRegime(b15,3,8,0.20);

  if(!sma1.ready||!fr1.ready||!m1.ready||!ar1.ready||!atr1.ready||!rsi1.ready||!dmi.ready||!pressure.ready||!regime5.ready||!regime15.ready){
    return {ok:false,grade:"NO TRADE",reason:"multi-timeframe A-grade context not ready"};
  }

  const last=Number(ticks.at(-1)?.p);
  if(!Number.isFinite(last))return {ok:false,grade:"NO TRADE",reason:"no valid live price"};

  const spreadInfo=spreadQualitySnapshot(symbol,ticks,last,atr1.atr);
  const spreadAtrRatio=spreadInfo.spreadAtrRatio;
  const spreadBps=spreadInfo.spreadBps;
  const atrRatio=last>0?atr1.atr/last:0;

  if(spreadInfo.abnormal){
    return {
      ok:false,grade:"NO TRADE",reason:"spread is abnormally wide",
      spreadAtrRatio,spreadBps,spreadSamples:spreadInfo.samples
    };
  }
  if(atrRatio<0.000006||atrRatio>0.0040){
    return {ok:false,grade:"NO TRADE",reason:"volatility is outside the A-grade range",atrRatio};
  }

  let direction="NEUTRAL";
  if(sma1.fast>sma1.slow&&sma1.fastSlope>0)direction="CALL";
  if(sma1.fast<sma1.slow&&sma1.fastSlope<0)direction="PUT";
  if(direction==="NEUTRAL")return {ok:false,grade:"NO TRADE",reason:"1m SMA(5/13) trend is unclear"};

  // A-grade requires both completed higher timeframes to agree with the 1m entry direction.
  if(regime5.direction!==direction){
    return {ok:false,grade:"NO TRADE",reason:"completed 5m trend is not aligned",coreDirection:direction,regime5:regime5.direction};
  }
  if(regime15.direction!==direction){
    return {ok:false,grade:"NO TRADE",reason:"completed 15m trend is not aligned",coreDirection:direction,regime15:regime15.direction};
  }

  // Structural failure is an absolute veto.
  if(direction==="CALL"&&fr1.lastLow&&last<=Number(fr1.lastLow.price)){
    return {ok:false,grade:"NO TRADE",reason:"Fractal(2) support failed",coreDirection:direction};
  }
  if(direction==="PUT"&&fr1.lastHigh&&last>=Number(fr1.lastHigh.price)){
    return {ok:false,grade:"NO TRADE",reason:"Fractal(2) resistance failed",coreDirection:direction};
  }

  // Pullback + continuation: price must have revisited the fast average recently, then resumed.
  const recent=bars1m.slice(-7);
  const nearFast=recent.some(b=>{
    if(direction==="CALL") return Number(b.l)<=sma1.fast+0.50*atr1.atr;
    return Number(b.h)>=sma1.fast-0.50*atr1.atr;
  });
  if(!nearFast)return {ok:false,grade:"NO TRADE",reason:"no recent pullback toward SMA(5)",coreDirection:direction};

  const distanceFast=Math.abs(last-sma1.fast)/atr1.atr;
  if(distanceFast>1.00){
    return {ok:false,grade:"NO TRADE",reason:"entry is already extended from SMA(5)",distanceFastAtr:distanceFast,coreDirection:direction};
  }
  if((direction==="CALL"&&last<=sma1.fast)||(direction==="PUT"&&last>=sma1.fast)){
    return {ok:false,grade:"NO TRADE",reason:"pullback has not resumed beyond SMA(5)",coreDirection:direction};
  }

  const last2=bars1m.slice(-2);
  const continuation=last2.some(b=>direction==="CALL"
    ? Number(b.c)>Number(b.o)&&Number(b.c)>=sma1.fast
    : Number(b.c)<Number(b.o)&&Number(b.c)<=sma1.fast);
  if(!continuation)return {ok:false,grade:"NO TRADE",reason:"no completed 1m continuation candle",coreDirection:direction};

  const macdAligned=direction==="CALL"
    ? (m1.macd>m1.signal&&m1.hist>0)
    : (m1.macd<m1.signal&&m1.hist<0);
  if(!macdAligned)return {ok:false,grade:"NO TRADE",reason:"1m MACD is not aligned",coreDirection:direction};

  const dmiAligned=direction==="CALL"
    ? dmi.plusDI>dmi.minusDI+3
    : dmi.minusDI>dmi.plusDI+3;
  if(!dmiAligned||dmi.adx<17){
    return {ok:false,grade:"NO TRADE",reason:"ADX/DMI trend strength is insufficient",adx:dmi.adx,coreDirection:direction};
  }

  const rsiAligned=direction==="CALL"
    ? (rsi1.rsi>=49&&rsi1.rsi<=71)
    : (rsi1.rsi<=51&&rsi1.rsi>=29);
  if(!rsiAligned)return {ok:false,grade:"NO TRADE",reason:"RSI(7) is outside the A-grade continuation zone",rsi:rsi1.rsi};

  const aroonAligned=direction==="CALL"
    ? ar1.up>ar1.down+12
    : ar1.down>ar1.up+12;
  if(!aroonAligned)return {ok:false,grade:"NO TRADE",reason:"Aroon does not confirm direction",coreDirection:direction};

  // Room-to-move veto: avoid CALL into nearby resistance or PUT into nearby support.
  const room=roomToMoveSnapshot(bars1m,last,direction,atr1.atr);
  if(!room.ready||room.roomAtr<1.10){
    return {ok:false,grade:"NO TRADE",reason:"insufficient room to move before higher-timeframe support/resistance",roomAtr:room.roomAtr};
  }

  // Live ticks are used only as a reversal veto, not as a 15-second trigger.
  const imp=tickImpulse(ticks);
  if(imp.ready){
    const strongOpp=direction==="CALL"
      ? (imp.downRatio>=0.70&&imp.norm<0)
      : (imp.upRatio>=0.70&&imp.norm>0);
    if(strongOpp)return {ok:false,grade:"NO TRADE",reason:"live Tiingo ticks show a strong reversal against entry",coreDirection:direction};
  }

  let score=8.0;
  const reasons=[
    "1m SMA(5/13) aligned",
    "completed 5m trend aligned",
    "completed 15m trend aligned",
    "Fractal(2) structure intact",
    "pullback + continuation confirmed",
    "1m MACD aligned",
    "ADX/DMI aligned",
    "RSI(7) aligned",
    "Aroon aligned",
    "room-to-move passed"
  ];
  if((direction==="CALL"&&sma1.slowSlope>=0)||(direction==="PUT"&&sma1.slowSlope<=0)){score+=0.5;reasons.push("SMA(13) slope supportive");}
  const pressureAligned=direction==="CALL"?pressure.bull>=2:pressure.bear>=2;
  if(pressureAligned){score+=0.4;reasons.push("1m candle pressure aligned");}
  if(imp.ready){
    const tickAligned=direction==="CALL"?(imp.upRatio>=0.55&&imp.norm>0):(imp.downRatio>=0.55&&imp.norm<0);
    if(tickAligned){score+=0.4;reasons.push("live tick flow aligned");}
  }

  const quality=clamp(
    0.82 + Math.min(score-8,1.3)*0.035 +
    Math.min(regime5.efficiency,0.7)*0.025 +
    Math.min(regime15.efficiency,0.7)*0.025 +
    Math.min(dmi.adx,35)/35*0.025,
    0.82,0.94
  );
  if(quality<A_GRADE_MIN_QUALITY){
    return {ok:false,grade:"NO TRADE",reason:`setup quality ${(quality*100).toFixed(1)}% is below A-grade threshold`,quality};
  }

  return {
    ok:true,grade:"A",direction,expirySeconds:EXPIRY_SECONDS,quality,
    callScore:direction==="CALL"?score:0,putScore:direction==="PUT"?score:0,
    edge:score,coreMajor:8,microConfirmations:0,microScore:0,
    regime5:regime5.direction,regime15:regime15.direction,
    regime5Efficiency:regime5.efficiency,regime15Efficiency:regime15.efficiency,
    roomAtr:room.roomAtr,spreadAtrRatio,spreadBps,atrRatio,rsi:rsi1.rsi,adx:dmi.adx,
    smaFastPeriod:5,smaSlowPeriod:13,fractalPeriod:2,timeframe:"1min",expiryMinutes:5,
    smaFast:sma1.fast,smaSlow:sma1.slow,distanceFastAtr:distanceFast,
    reasons,bars1m:bars1m.length,lastPrice:last
  };
}

export class TickHub extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx; this.env=env; this.ws=null; this.cryptoWs=null; this.ticks=new Map(); this.symbols=new Set();
    this.lastStatus="starting"; this.lastSubscribeStatus=null; this.connecting=false; this.cryptoConnecting=false; this.provider="tiingo"; this.lastCryptoStatus="starting"; this.lastCryptoSubscribeStatus=null; this.lastCryptoWsMessageAt=0;
    this.lastWsMessageAt=0; this.lastPriceReceivedAt=0; this.lastConnectAt=0; this.reconnectCount=0; this.oneMinuteCache=new Map(); this.quotaBlockedUntil=0; this.pendingSignals=[]; this.signalStats={total:0,wins:0,losses:0,draws:0,voids:0}; this.signalHistory=[]; this.alertChats=[];

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
      this.alertChats=(await this.ctx.storage.get("alertChats"))||[];
      if(!this.alertChats.length){
        const recovered=[...this.pendingSignals,...this.signalHistory]
          .flatMap(x=>Array.isArray(x.chatIds)?x.chatIds:[x.chatId])
          .filter(x=>x!=null)
          .map(String);
        this.alertChats=[...new Set(recovered)].slice(-10);
        if(this.alertChats.length)await this.ctx.storage.put("alertChats",this.alertChats);
      }
      await this.ensureSocket();
      await this.ensureCryptoSocket();
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
        const chats=Array.isArray(sig.chatIds)&&sig.chatIds.length?sig.chatIds:[sig.chatId];
        for(const chat of chats) if(chat!=null) await this.sendTrackedResult(
          chat,
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
      const chats=Array.isArray(sig.chatIds)&&sig.chatIds.length?sig.chatIds:[sig.chatId];
      for(const chat of chats) if(chat!=null) await this.sendTrackedResult(
        chat,
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
      await this.ensureCryptoSocket();

      if(this.ws&&this.ws.readyState===1){
        const msgAge=this.lastWsMessageAt?((Date.now()-this.lastWsMessageAt)/1000):Infinity;
        if(msgAge>45) await this.forceReconnect("no FX websocket messages for >45s");
      }else{
        await this.forceReconnect("FX socket not open");
      }

      if([...this.symbols].some(isCryptoSymbol)){
        if(this.cryptoWs&&this.cryptoWs.readyState===1){
          const msgAge=this.lastCryptoWsMessageAt?((Date.now()-this.lastCryptoWsMessageAt)/1000):Infinity;
          if(msgAge>45) await this.forceCryptoReconnect("no crypto websocket messages for >45s");
        }else{
          await this.forceCryptoReconnect("crypto socket not open");
        }
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
    try{ if(this.ws){ try{this.ws.close(1000,"reconnect");}catch(_){} } }catch(_){}
    this.ws=null;
    this.connecting=false;
    await sleep(150);
    await this.ensureSocket(true);
  }

  async forceCryptoReconnect(reason="manual reconnect"){
    this.reconnectCount++;
    this.lastCryptoStatus=`reconnecting: ${reason}`;
    try{ if(this.cryptoWs){ try{this.cryptoWs.close(1000,"reconnect");}catch(_){} } }catch(_){}
    this.cryptoWs=null;
    this.cryptoConnecting=false;
    await sleep(150);
    await this.ensureCryptoSocket(true);
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

        const tickers=[...this.symbols].filter(x=>!isCryptoSymbol(x)).map(toTiingoSymbol).filter(Boolean);
        ws.send(JSON.stringify({
          eventName:"subscribe",
          authorization:key,
          eventData:{thresholdLevel:5,tickers}
        }));
      });

      ws.addEventListener("message",ev=>this.onMessage(ev));
      ws.addEventListener("close",()=>{
        if(this.ws===ws)this.ws=null;
        this.connecting=false;
        this.lastStatus="closed";
      });
      ws.addEventListener("error",()=>{this.lastStatus="tiingo fx websocket error";});
    }catch(e){
      this.connecting=false;
      this.ws=null;
      this.lastStatus=String(e?.message||e);
    }
  }

  async ensureCryptoSocket(force=false){
    const wantsCrypto=[...this.symbols].some(isCryptoSymbol);
    if(!wantsCrypto)return;
    if(!force && this.cryptoWs&&this.cryptoWs.readyState===1)return;
    if(this.cryptoConnecting)return;

    const key=String(this.env.TIINGO_API_TOKEN||"").trim();
    if(!key){this.lastCryptoStatus="missing TIINGO_API_TOKEN";return;}

    this.cryptoConnecting=true;
    try{
      const ws=new WebSocket("wss://api.tiingo.com/crypto");
      this.cryptoWs=ws;

      ws.addEventListener("open",()=>{
        this.cryptoConnecting=false;
        this.lastCryptoWsMessageAt=Date.now();
        this.lastCryptoStatus="connected";
        const tickers=[...this.symbols].filter(isCryptoSymbol).map(toTiingoSymbol).filter(Boolean);
        ws.send(JSON.stringify({
          eventName:"subscribe",
          authorization:key,
          eventData:{thresholdLevel:2,tickers}
        }));
      });

      ws.addEventListener("message",ev=>this.onCryptoMessage(ev));
      ws.addEventListener("close",()=>{
        if(this.cryptoWs===ws)this.cryptoWs=null;
        this.cryptoConnecting=false;
        this.lastCryptoStatus="closed";
      });
      ws.addEventListener("error",()=>{this.lastCryptoStatus="tiingo crypto websocket error";});
    }catch(e){
      this.cryptoConnecting=false;
      this.cryptoWs=null;
      this.lastCryptoStatus=String(e?.message||e);
    }
  }

  pushTick(symbol,t,p,bid=null,ask=null){
    const r=Date.now();
    if(!symbol||!Number.isFinite(p)||!Number.isFinite(t)||!this.symbols.has(symbol))return;
    this.lastPriceReceivedAt=r;
    const arr=this.ticks.get(symbol)||[];
    arr.push({t,p,r,bid:Number.isFinite(bid)?bid:null,ask:Number.isFinite(ask)?ask:null});
    const cutoff=Date.now()-45*60*1000;
    while(arr.length&&Number(arr[0].r||arr[0].t)<cutoff)arr.shift();
    if(arr.length>20000)arr.splice(0,arr.length-20000);
    this.ticks.set(symbol,arr);
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
        this.lastStatus=`tiingo fx error: ${x?.response?.message||"subscription error"}`;
        return;
      }
      if(x.messageType!=="A"||x.service!=="fx"||!Array.isArray(x.data))return;
      const d=x.data;
      if(d[0]!=="Q")return;
      const symbol=fromTiingoSymbol(d[1]);
      const t=Date.parse(String(d[2]||""));
      const bid=Number(d[4]), mid=Number(d[5]), ask=Number(d[7]);
      const p=Number.isFinite(mid)?mid:(Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:NaN);
      if(!Number.isFinite(p)||!Number.isFinite(t))return;
      this.lastStatus="ok";
      this.pushTick(symbol,t,p,bid,ask);
    }catch(e){
      this.lastStatus=`tiingo fx parse error: ${String(e?.message||e)}`;
    }
  }

  onCryptoMessage(ev){
    this.lastCryptoWsMessageAt=Date.now();
    try{
      const x=JSON.parse(String(ev.data||"{}"));
      if(x.messageType==="I"){
        this.lastCryptoSubscribeStatus=x;
        this.lastCryptoStatus=x?.response?.message||"subscribed";
        return;
      }
      if(x.messageType==="H"){
        if(this.lastCryptoStatus==="closed"||this.lastCryptoStatus.startsWith("reconnecting"))this.lastCryptoStatus="connected";
        return;
      }
      if(x.messageType==="E"){
        this.lastCryptoSubscribeStatus=x;
        this.lastCryptoStatus=`tiingo crypto error: ${x?.response?.message||"subscription error"}`;
        return;
      }
      if(x.messageType!=="A"||x.service!=="crypto_data"||!Array.isArray(x.data))return;
      const d=x.data;
      const symbol=fromTiingoSymbol(d[1]);
      const t=Date.parse(String(d[2]||""));
      let p=NaN,bid=null,ask=null;
      if(d[0]==="T"){
        p=Number(d[5]);
      }else if(d[0]==="Q"){
        bid=Number(d[5]); const mid=Number(d[6]); ask=Number(d[8]);
        p=Number.isFinite(mid)?mid:(Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:NaN);
      }else return;
      if(!Number.isFinite(p)||!Number.isFinite(t))return;
      this.lastCryptoStatus="ok";
      this.pushTick(symbol,t,p,bid,ask);
    }catch(e){
      this.lastCryptoStatus=`tiingo crypto parse error: ${String(e?.message||e)}`;
    }
  }

  async refreshIfStale(symbol){
    const receiveAge=this.latestReceivedAge(symbol);
    const crypto=isCryptoSymbol(symbol);
    const msgAge=crypto
      ? (this.lastCryptoWsMessageAt?Math.max(0,(Date.now()-this.lastCryptoWsMessageAt)/1000):Infinity)
      : (this.lastWsMessageAt?Math.max(0,(Date.now()-this.lastWsMessageAt)/1000):Infinity);

    if(!Number.isFinite(receiveAge)){
      if(crypto) await this.ensureCryptoSocket();
      else await this.ensureSocket();
      return;
    }

    const open=crypto
      ? Boolean(this.cryptoWs&&this.cryptoWs.readyState===1)
      : Boolean(this.ws&&this.ws.readyState===1);

    if(receiveAge>15||msgAge>45||!open){
      if(crypto) await this.forceCryptoReconnect(`stale ${symbol} feed`);
      else await this.forceReconnect(`stale ${symbol} feed`);
      await sleep(1800);
    }
  }

  async subscribe(symbol){
    symbol=normalizeSymbol(symbol);
    if(!symbol||!FIXED_UNIVERSE.includes(symbol))return false;

    if(!this.symbols.has(symbol)){
      this.symbols.add(symbol);
      await this.ctx.storage.put("symbols",[...this.symbols]);
      if(isCryptoSymbol(symbol)) await this.forceCryptoReconnect("ticker universe changed");
      else await this.forceReconnect("ticker universe changed");
    }else{
      if(isCryptoSymbol(symbol)) await this.ensureCryptoSocket();
      else await this.ensureSocket();
    }
    return true;
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
    return [...merged.values()].sort((a,b)=>a.t-b.t).slice(-480);
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
    if(!ticker)throw new Error("invalid Tiingo ticker");

    const start=new Date(Date.now()-24*60*60*1000).toISOString().slice(0,10);
    let url;
    if(isCryptoSymbol(symbol)){
      url=new URL("https://api.tiingo.com/tiingo/crypto/prices");
      url.searchParams.set("tickers",ticker);
      url.searchParams.set("startDate",start);
      url.searchParams.set("resampleFreq","1min");
    }else{
      url=new URL(`https://api.tiingo.com/tiingo/fx/${ticker}/prices`);
      url.searchParams.set("startDate",start);
      url.searchParams.set("resampleFreq","1min");
    }

    const res=await fetch(url.toString(),{
      headers:{accept:"application/json",authorization:`Token ${key}`}
    });

    let data;
    try{data=await res.json();}catch(_){data=null;}

    if(!res.ok||!Array.isArray(data)){
      const msg=String(data?.detail||data?.message||`Tiingo 1m context request failed (${res.status})`);
      if(/hourly request allocation|hourly.*limit|request.*hour/i.test(msg)){
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
    let rows=data;
    if(isCryptoSymbol(symbol)){
      const item=data.find(x=>String(x?.ticker||"").toLowerCase()===ticker)||data[0];
      rows=Array.isArray(item?.priceData)?item.priceData:[];
    }

    const restBars=rows.map(v=>({
      t:Date.parse(String(v.date||"")),
      o:Number(v.open),h:Number(v.high),l:Number(v.low),c:Number(v.close),n:Number(v.tradesDone||1)
    })).filter(b=>Number.isFinite(b.t)&&[b.o,b.h,b.l,b.c].every(Number.isFinite)&&b.t<currentMinute)
      .sort((a,b)=>a.t-b.t)
      .slice(-480);

    if(restBars.length<30)throw new Error(`only ${restBars.length} completed Tiingo 1m bars available for ${symbol}`);

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
    if(pairWait>0)return {ok:false,cooldown:true,retrySeconds:pairWait,symbol,reason:"pair cooldown"};

    await this.subscribe(symbol);
    if(isCryptoSymbol(symbol)) await this.ensureCryptoSocket();
    else await this.ensureSocket();
    await this.refreshIfStale(symbol);

    let arr=this.ticks.get(symbol)||[];
    if(arr.length<8){await sleep(1000);arr=this.ticks.get(symbol)||[];}

    const receiveAge=arr.length?this.latestReceivedAge(symbol):Infinity;
    const marketAge=arr.length?this.latestMarketAge(symbol):Infinity;
    const status=isCryptoSymbol(symbol)?this.lastCryptoStatus:this.lastStatus;

    if(!arr.length){
      return {ok:false,warming:true,symbol,ticks:0,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status,reason:"waiting for first live Tiingo quote"};
    }
    if(receiveAge>12){
      return {ok:false,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status,reason:`live feed stale: no received tick for ${receiveAge.toFixed(1)}s`};
    }
    if(marketAge>20){
      return {ok:false,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status,reason:`Tiingo quote timestamp is ${marketAge.toFixed(1)}s behind live time`};
    }

    let bars1m;
    try{bars1m=await this.fetchOneMinuteBars(symbol);}
    catch(e){
      if(e?.quotaExceeded){
        return {ok:false,quotaExceeded:true,retryAfterMinutes:Number(e.retryAfterMinutes)||1,symbol,ticks:arr.length,
          receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,status,
          reason:"Tiingo hourly request quota is temporarily exhausted"};
      }
      return {ok:false,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status,reason:`1m context unavailable: ${String(e?.message||e)}`};
    }

    const x=score5m(arr,bars1m,symbol);
    if(!x.ok)return {...x,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,status};
    return {...x,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
      status,reconnectCount:this.reconnectCount,generatedAt:Date.now()};
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
    // Do not globally block /signal while another 5-minute trade is still pending.
    // pairCooldownSeconds() already excludes the active pair, so the remaining pairs
    // can still be scanned for independent qualified opportunities.

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
    const chatIds=Array.isArray(body?.chatIds)?body.chatIds.map(String).filter(Boolean):[];
    const sourceUpdateId=String(body?.sourceUpdateId??"");
    const entryAt=Number(body?.entryAt)||Date.now();

    if(!symbol||!FIXED_UNIVERSE.includes(symbol))return {ok:false,error:"invalid symbol"};
    if(!["CALL","PUT"].includes(direction))return {ok:false,error:"invalid direction"};
    if(!Number.isFinite(entryPrice)||(chatId==null&&!chatIds.length))return {ok:false,error:"invalid tracking payload"};

    if(sourceUpdateId){
      const duplicate=this.pendingSignals.find(x=>String(x.sourceUpdateId)===sourceUpdateId)||
        this.signalHistory.find(x=>String(x.sourceUpdateId)===sourceUpdateId);
      if(duplicate)return {ok:true,duplicate:true,id:duplicate.id};
    }

    const sig={
      id:crypto.randomUUID(),
      sourceUpdateId,
      chatId:chatId==null?(chatIds[0]||null):chatId,
      chatIds:chatIds.length?chatIds:undefined,
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

  async registerAlertChat(req){
    const body=await req.json();
    const chatId=body?.chatId;
    if(chatId==null)return {ok:false,error:"missing chatId"};
    const id=String(chatId);
    if(!this.alertChats.includes(id)){
      this.alertChats.push(id);
      this.alertChats=this.alertChats.slice(-10);
      await this.ctx.storage.put("alertChats",this.alertChats);
    }
    return {ok:true,chatId:id,count:this.alertChats.length};
  }

  async getAlertChats(){
    return {ok:true,chats:[...this.alertChats]};
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
      await this.forceCryptoReconnect("requested");
      return json({
        ok:true,version:VERSION,
        fxStatus:this.lastStatus,cryptoStatus:this.lastCryptoStatus,
        reconnectCount:this.reconnectCount
      });
    }

    if(u.pathname==="/signal")return json(await this.analyze(symbol));
    if(u.pathname==="/quote"){
      if(!symbol)return json({ok:false,error:"invalid symbol"},400);
      await this.subscribe(symbol);
      if(isCryptoSymbol(symbol)) await this.ensureCryptoSocket();
      else await this.ensureSocket();
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
    if(u.pathname==="/register-chat"&&req.method==="POST")return json(await this.registerAlertChat(req));
    if(u.pathname==="/chats")return json(await this.getAlertChats());
    if(u.pathname==="/track"&&req.method==="POST")return json(await this.trackSignal(req));
    if(u.pathname==="/stats")return json(await this.getTrackingStats());

    if(u.pathname==="/status"){
      if(symbol) await this.subscribe(symbol);
      const crypto=isCryptoSymbol(symbol);

      if(symbol&&Number.isFinite(this.latestReceivedAge(symbol))&&this.latestReceivedAge(symbol)>30){
        try{
          if(crypto) await this.forceCryptoReconnect(`status detected stale ${symbol}`);
          else await this.forceReconnect(`status detected stale ${symbol}`);
        }catch(_){}
      }else{
        if(crypto) await this.ensureCryptoSocket();
        else await this.ensureSocket();
      }

      const arr=symbol?(this.ticks.get(symbol)||[]):[];
      const connected=crypto
        ? Boolean(this.cryptoWs&&this.cryptoWs.readyState===1)
        : Boolean(this.ws&&this.ws.readyState===1);
      const status=crypto?this.lastCryptoStatus:this.lastStatus;
      const subscribeStatus=crypto?this.lastCryptoSubscribeStatus:this.lastSubscribeStatus;
      const lastMessageAt=crypto?this.lastCryptoWsMessageAt:this.lastWsMessageAt;
      const lastMessageAge=lastMessageAt?Math.max(0,(Date.now()-lastMessageAt)/1000):null;

      return json({
        version:VERSION,
        provider:crypto?"tiingo-crypto":"tiingo-fx",
        status,
        subscribeStatus,
        connected,
        symbols:[...this.symbols],
        symbol,
        ticks:arr.length,
        bars60:buildBars(arr,60).length,
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


async function scanUniverse(env){
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

  const qualified=checked.filter(x=>x?.ok&&x?.grade==="A"&&x?.direction&&Number(x.quality)>=A_GRADE_MIN_QUALITY);
  qualified.sort((a,b)=>
    Number(b.quality||0)-Number(a.quality||0) ||
    Number(b.edge||0)-Number(a.edge||0) ||
    Number(b.microConfirmations||0)-Number(a.microConfirmations||0)
  );

  if(!qualified.length){
    return {ok:false,checked,reason:"No A-grade 5-minute entry across the eight-symbol universe."};
  }
  return {ok:true,best:qualified[0],checked};
}


async function issueAgradeSignal(env,chatIds,candidate,sourceUpdateId="auto",automatic=false){
  const chats=(chatIds||[]).map(String).filter(Boolean);
  if(!chats.length)return {ok:false,reason:"no alert chat registered"};

  const symbol=candidate.symbol;
  const result=await hub(env,`/signal?symbol=${encodeURIComponent(symbol)}`);
  if(!result.ok||result.grade!=="A"||result.direction!==candidate.direction||Number(result.quality)<A_GRADE_MIN_QUALITY){
    return {ok:false,reason:"setup changed during final check"};
  }

  const quoteBefore=await hub(env,`/quote?symbol=${encodeURIComponent(symbol)}`);
  if(!quoteBefore.ok||!Number.isFinite(Number(quoteBefore.price))||Number(quoteBefore.receiveAgeSeconds)>12){
    return {ok:false,reason:"fresh entry quote unavailable"};
  }

  const arrow=result.direction==="CALL"?"⬆️":"⬇️";
  const label=automatic?"AUTO A-GRADE SIGNAL":"A-GRADE SIGNAL";
  const textMsg=`${arrow} ${symbol}\n${label}\nEXPIRY: 5 minutes\nGRADE: A\nQUALITY: ${(Number(result.quality)*100).toFixed(1)}%\nTRACKING: ON`;

  let sentAt=null;
  for(const chat of chats){
    const sent=await tgSend(env,chat,textMsg);
    if(sent?.date&&!sentAt)sentAt=sent.date;
  }

  const quoteAfter=await hub(env,`/quote?symbol=${encodeURIComponent(symbol)}`);
  const entryPrice=quoteAfter.ok&&Number.isFinite(Number(quoteAfter.price))
    ? Number(quoteAfter.price)
    : Number(quoteBefore.price);

  await hubPost(env,"/track",{
    sourceUpdateId:String(sourceUpdateId),
    chatIds:chats,
    symbol,
    direction:result.direction,
    entryPrice,
    entryAt:Date.now(),
    telegramMessageDate:sentAt
  });
  return {ok:true,symbol,direction:result.direction,quality:result.quality};
}

async function autoScanAndAlert(env){
  const chatState=await hub(env,"/chats");
  const chats=Array.isArray(chatState?.chats)?chatState.chats:[];
  if(!chats.length)return {ok:false,reason:"no registered chat"};

  const risk=await hub(env,"/risk");
  if(!risk.ok)return {ok:false,reason:risk.reason||"risk gate"};

  const scan=await scanUniverse(env);
  if(!scan.ok)return {ok:false,reason:scan.reason||"no A-grade setup"};

  const minuteKey=Math.floor(Date.now()/60000);
  return await issueAgradeSignal(env,chats,scan.best,`auto-${minuteKey}-${scan.best.symbol}`,true);
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
        if(received<=12 && provider<=20) health="LIVE";
        else if(received<=30 && provider<=45) health="WARMING";
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
    if(request.method!=="POST")return new Response("V12.0.1 adaptive-spread A-grade scanner",{status:200});
    if(u.pathname!=="/telegram")return new Response("Not found",{status:404});
    const secret=String(env.TELEGRAM_WEBHOOK_SECRET||"").trim();
    if(secret&&request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==secret)return new Response("forbidden",{status:403});
    const update=await request.json(); const msg=update.message||update.edited_message; if(!msg?.chat?.id)return new Response("ok");
    const chatId=msg.chat.id, text=String(msg.text||"").trim();
    await hubPost(env,"/register-chat",{chatId});
    if(/^\/version$/i.test(text)){await tgSend(env,chatId,VERSION);return new Response("ok");}
    if(/^\/start$/i.test(text)){
      await tgSend(
        env,
        chatId,
        "V12.0.1 — A-GRADE AUTO MODE. Eight symbols with 5-minute expiry. The spread gate now uses a recent median and asset-aware abnormal-spread sanity check, so ordinary Tiingo quote differences no longer block otherwise valid A-grade setups. Automatic one-minute scanning remains active."
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
        `EIGHT-SYMBOL FEED HEALTH\nLIVE: ${liveCount}/${FIXED_UNIVERSE.length}\n\n${lines.join("\n\n")}`
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
          rows.push(`${symbol}: ${r.ok&&r.grade==="A"?"A-GRADE":(r.reason||"not ready")}`);
        }catch(e){
          rows.push(`${symbol}: error`);
        }
      }
      await tgSend(env,chatId,`V12 A-GRADE DIAGNOSIS\n\n${rows.join("\n")}`);
      return new Response("ok");
    }
    if(/^\/reconnect$/i.test(text)){
      const st=await hub(env,"/reconnect");
      await tgSend(env,chatId,`FEED RECONNECT REQUESTED\nFX: ${st.fxStatus||"n/a"}\nCRYPTO: ${st.cryptoStatus||"n/a"}\nRECONNECTS: ${st.reconnectCount||0}`);
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
        `1m LIVE BARS: ${st.bars60||0}\n`+
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

      const scan=await scanUniverse(env);
      if(!scan.ok){
        if(scan.quotaExceeded){
          const mins=Math.max(1,Number(scan.retryAfterMinutes)||1);
          await tgSend(
            env,
            chatId,
            `⏳ DATA LIMIT REACHED\nTry /signal again in about ${mins} minute${mins===1?"":"s"}.\nThe bot will scan all 8 symbols again and only issue Grade A.`
          );
          return new Response("ok");
        }

        const checked=scan.checked||[];
        const warming=checked.filter(x=>x?.warming);
        if(checked.length&&warming.length===checked.length){
          await tgSend(
            env,
            chatId,
            "⏳ LIVE FEEDS STARTING\nNo usable live Tiingo quote is available yet across the eight-symbol scan. Try /signal again in about 1 minute."
          );
          return new Response("ok");
        }

        const reasons=checked.map(x=>x?.reason).filter(Boolean);
        const top=reasons.length?reasons.sort((x,y)=>
          reasons.filter(z=>z===y).length-reasons.filter(z=>z===x).length
        )[0]:null;
        await tgSend(
          env,
          chatId,
          `⏳ NO A-GRADE 5-MINUTE SETUP RIGHT NOW\nFeeds are live across the scan.${top?"\nMain blocker: "+top:""}\nAutomatic scanning remains active.`
        );
        return new Response("ok");
      }

      const issued=await issueAgradeSignal(env,[chatId],scan.best,`manual-${update.update_id}`,false);
      if(!issued.ok){
        await tgSend(env,chatId,`⏳ ${issued.reason||"setup failed final validation"}\nAutomatic scanning remains active.`);
      }
      return new Response("ok");
    }

    if(/^\/signal\b/i.test(text)){
      await tgSend(env,chatId,"Use /signal by itself. The bot scans all 8 symbols and returns only the strongest A-grade 5-minute setup. Automatic scans also run every minute.");
      return new Response("ok");
    }

    return new Response("ok");
  },

  async scheduled(controller,env,ctx){
    ctx.waitUntil(autoScanAndAlert(env).catch(()=>{}));
  }

};
