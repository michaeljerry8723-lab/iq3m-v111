import { DurableObject } from "cloudflare:workers";

const VERSION = "1.0.0-forex-daytrader";
const SYMBOLS = ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","USD/CHF","XAU/USD","BTC/USD"];
const FX_SYMBOLS = SYMBOLS.filter(s => s !== "BTC/USD");
const CRYPTO_SYMBOLS = ["BTC/USD"];
const MIN_SCORE = 82;
const MAX_HOLD_MINUTES = 360;
const TARGET_R_MULTIPLE = 2;

function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{"content-type":"application/json;charset=UTF-8"}});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function clamp(x,a,b){return Math.max(a,Math.min(b,Number(x)||0));}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+Number(b),0)/xs.length:NaN;}
function normalizeSymbol(input){
  let s=String(input||"").trim().toUpperCase().replace(/\s+/g,"").replace(/[-_]/g,"/");
  if(/^[A-Z]{6}$/.test(s))s=s.slice(0,3)+"/"+s.slice(3);
  return SYMBOLS.includes(s)?s:null;
}
function tiingoTicker(symbol){return String(symbol||"").replace("/","").toLowerCase();}
function fromTicker(ticker){
  const x=String(ticker||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
  if(x.length===6)return x.slice(0,3)+"/"+x.slice(3);
  return null;
}
function formatPrice(symbol,p){
  const n=Number(p); if(!Number.isFinite(n))return "n/a";
  if(symbol==="BTC/USD")return n.toFixed(2);
  if(symbol==="XAU/USD")return n.toFixed(2);
  if(symbol.endsWith("/JPY"))return n.toFixed(3);
  return n.toFixed(5);
}
function buildBarsFromTicks(ticks,spanMs){
  const m=new Map();
  for(const t of ticks){
    const bucket=Math.floor(Number(t.t)/spanMs)*spanMs;
    let b=m.get(bucket);
    if(!b){b={t:bucket,o:t.p,h:t.p,l:t.p,c:t.p,n:1};m.set(bucket,b);}
    else{b.h=Math.max(b.h,t.p);b.l=Math.min(b.l,t.p);b.c=t.p;b.n++;}
  }
  return [...m.values()].sort((a,b)=>a.t-b.t);
}
function resampleBars(bars,spanMs){
  const m=new Map();
  for(const b of bars){
    const bucket=Math.floor(Number(b.t)/spanMs)*spanMs;
    let x=m.get(bucket);
    if(!x){x={t:bucket,o:Number(b.o),h:Number(b.h),l:Number(b.l),c:Number(b.c),n:Number(b.n||1)};m.set(bucket,x);}
    else{x.h=Math.max(x.h,Number(b.h));x.l=Math.min(x.l,Number(b.l));x.c=Number(b.c);x.n+=Number(b.n||1);}
  }
  return [...m.values()].sort((a,b)=>a.t-b.t);
}
function mergeBars(base,live){
  const m=new Map();
  for(const b of [...base,...live]){
    const k=Number(b.t); const prev=m.get(k);
    if(!prev)m.set(k,{...b});
    else m.set(k,{t:k,o:Number(prev.o),h:Math.max(Number(prev.h),Number(b.h)),l:Math.min(Number(prev.l),Number(b.l)),c:Number(b.c),n:Number(prev.n||0)+Number(b.n||0)});
  }
  return [...m.values()].sort((a,b)=>a.t-b.t).slice(-1600);
}
function emaSeries(vals,p){
  const out=new Array(vals.length).fill(NaN); if(vals.length<p)return out;
  let seed=mean(vals.slice(0,p)); out[p-1]=seed; const k=2/(p+1);
  for(let i=p;i<vals.length;i++)out[i]=Number(vals[i])*k+out[i-1]*(1-k);
  return out;
}
function rsiSeries(vals,p=14){
  const out=new Array(vals.length).fill(NaN); if(vals.length<=p)return out;
  let gain=0,loss=0;
  for(let i=1;i<=p;i++){const d=Number(vals[i])-Number(vals[i-1]);if(d>=0)gain+=d;else loss-=d;}
  let ag=gain/p, al=loss/p; out[p]=al===0?100:100-(100/(1+ag/al));
  for(let i=p+1;i<vals.length;i++){
    const d=Number(vals[i])-Number(vals[i-1]); const g=Math.max(0,d), l=Math.max(0,-d);
    ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p; out[i]=al===0?100:100-(100/(1+ag/al));
  }
  return out;
}
function atrSeries(bars,p=14){
  const tr=new Array(bars.length).fill(NaN);
  for(let i=1;i<bars.length;i++)tr[i]=Math.max(Number(bars[i].h)-Number(bars[i].l),Math.abs(Number(bars[i].h)-Number(bars[i-1].c)),Math.abs(Number(bars[i].l)-Number(bars[i-1].c)));
  const out=new Array(bars.length).fill(NaN); if(bars.length<=p)return out;
  let seed=mean(tr.slice(1,p+1)); out[p]=seed;
  for(let i=p+1;i<bars.length;i++)out[i]=(out[i-1]*(p-1)+tr[i])/p;
  return out;
}
function adxSnapshot(bars,p=14){
  if(!bars||bars.length<p*2+3)return{ready:false};
  const tr=[],plusDM=[],minusDM=[];
  for(let i=1;i<bars.length;i++){
    const up=Number(bars[i].h)-Number(bars[i-1].h), dn=Number(bars[i-1].l)-Number(bars[i].l);
    plusDM.push(up>dn&&up>0?up:0); minusDM.push(dn>up&&dn>0?dn:0);
    tr.push(Math.max(Number(bars[i].h)-Number(bars[i].l),Math.abs(Number(bars[i].h)-Number(bars[i-1].c)),Math.abs(Number(bars[i].l)-Number(bars[i-1].c)));
  }
  let trS=mean(tr.slice(0,p))*p, pS=mean(plusDM.slice(0,p))*p, mS=mean(minusDM.slice(0,p))*p;
  const dx=[]; let lastPlus=0,lastMinus=0;
  for(let i=p;i<tr.length;i++){
    trS=trS-trS/p+tr[i]; pS=pS-pS/p+plusDM[i]; mS=mS-mS/p+minusDM[i];
    lastPlus=trS?100*pS/trS:0; lastMinus=trS?100*mS/trS:0;
    const den=lastPlus+lastMinus; dx.push(den?100*Math.abs(lastPlus-lastMinus)/den:0);
  }
  if(dx.length<p)return{ready:false};
  let adx=mean(dx.slice(0,p)); for(let i=p;i<dx.length;i++)adx=(adx*(p-1)+dx[i])/p;
  return{ready:true,adx,plusDI:lastPlus,minusDI:lastMinus};
}
function indicatorSnapshot(bars){
  if(!bars||bars.length<55)return{ready:false};
  const c=bars.map(b=>Number(b.c)), e9=emaSeries(c,9),e21=emaSeries(c,21),e50=emaSeries(c,50),r=rsiSeries(c,14),a=atrSeries(bars,14),i=bars.length-1;
  if(![e9[i],e21[i],e50[i],r[i],a[i]].every(Number.isFinite))return{ready:false};
  return{ready:true,close:c[i],ema9:e9[i],ema21:e21[i],ema50:e50[i],rsi:r[i],atr:a[i],slope21:e21[i]-e21[i-2],slope50:e50[i]-e50[i-2]};
}
function swingPoints(bars,left=2,right=2){
  const highs=[],lows=[];
  for(let i=left;i<bars.length-right;i++){
    let isH=true,isL=true;
    for(let j=1;j<=left;j++){if(Number(bars[i].h)<=Number(bars[i-j].h))isH=false;if(Number(bars[i].l)>=Number(bars[i-j].l))isL=false;}
    for(let j=1;j<=right;j++){if(Number(bars[i].h)<=Number(bars[i+j].h))isH=false;if(Number(bars[i].l)>=Number(bars[i+j].l))isL=false;}
    if(isH)highs.push({i,t:bars[i].t,p:Number(bars[i].h)}); if(isL)lows.push({i,t:bars[i].t,p:Number(bars[i].l)});
  }
  return{highs,lows};
}
function structureSnapshot(bars){
  if(!bars||bars.length<25)return{ready:false};
  const s=swingPoints(bars); if(s.highs.length<2||s.lows.length<2)return{ready:false};
  const h1=s.highs.at(-1),h0=s.highs.at(-2),l1=s.lows.at(-1),l0=s.lows.at(-2),last=Number(bars.at(-1).c);
  const hh=h1.p>h0.p, hl=l1.p>l0.p, lh=h1.p<h0.p, ll=l1.p<l0.p;
  let trend="RANGE"; if(hh&&hl)trend="BULL"; else if(lh&&ll)trend="BEAR";
  const bosUp=last>h1.p, bosDown=last<l1.p;
  return{ready:true,trend,bosUp,bosDown,lastHigh:h1,lastLow:l1,prevHigh:h0,prevLow:l0};
}
function liquiditySnapshot(bars,lookback=12){
  if(!bars||bars.length<lookback+2)return{ready:false};
  const prev=bars.slice(-(lookback+1),-1),last=bars.at(-1);
  const priorHigh=Math.max(...prev.map(b=>Number(b.h))), priorLow=Math.min(...prev.map(b=>Number(b.l)));
  const sweepHigh=Number(last.h)>priorHigh&&Number(last.c)<priorHigh;
  const sweepLow=Number(last.l)<priorLow&&Number(last.c)>priorLow;
  return{ready:true,sweepHigh,sweepLow,priorHigh,priorLow};
}
function sessionOk(symbol,now=Date.now()){
  if(symbol==="BTC/USD")return true;
  const d=new Date(now),day=d.getUTCDay(),h=d.getUTCHours();
  if(day===0||day===6)return false;
  return h>=6&&h<20;
}
function spreadOk(symbol,lastQuote){
  if(!lastQuote||!Number.isFinite(lastQuote.bid)||!Number.isFinite(lastQuote.ask)||lastQuote.bid<=0)return true;
  const pct=(lastQuote.ask-lastQuote.bid)/((lastQuote.ask+lastQuote.bid)/2)*100;
  const max=symbol==="BTC/USD"?0.12:symbol==="XAU/USD"?0.05:0.03;
  return pct<=max;
}
function scoreSetup(symbol,m5,m15,h1,lastQuote){
  const I5=indicatorSnapshot(m5),I15=indicatorSnapshot(m15),IH=indicatorSnapshot(h1),S15=structureSnapshot(m15),L15=liquiditySnapshot(m15),A5=adxSnapshot(m5);
  if(![I5.ready,I15.ready,IH.ready,S15.ready,L15.ready,A5.ready].every(Boolean))return{ok:false,reason:"insufficient multi-timeframe history"};
  const sideScores={BUY:0,SELL:0},reasons={BUY:[],SELL:[]};
  const add=(side,pts,reason)=>{sideScores[side]+=pts;reasons[side].push(`${reason} +${pts}`);};

  if(IH.ema21>IH.ema50&&IH.slope21>0&&IH.close>IH.ema21)add("BUY",20,"H1 bullish trend");
  else if(IH.ema21<IH.ema50&&IH.slope21<0&&IH.close<IH.ema21)add("SELL",20,"H1 bearish trend");
  else{
    if(IH.ema21>IH.ema50)add("BUY",10,"H1 partial bullish alignment");
    if(IH.ema21<IH.ema50)add("SELL",10,"H1 partial bearish alignment");
  }

  if(S15.trend==="BULL")add("BUY",14,"M15 higher-high/higher-low structure");
  if(S15.trend==="BEAR")add("SELL",14,"M15 lower-high/lower-low structure");
  if(S15.bosUp)add("BUY",6,"M15 bullish break of structure");
  if(S15.bosDown)add("SELL",6,"M15 bearish break of structure");

  if(L15.sweepLow)add("BUY",15,"M15 sell-side liquidity sweep");
  if(L15.sweepHigh)add("SELL",15,"M15 buy-side liquidity sweep");

  const dist21=Math.abs(I15.close-I15.ema21)/Math.max(I15.atr,1e-12);
  if(I15.close>=I15.ema21&&dist21<=0.9)add("BUY",10,"M15 bullish pullback/value area");
  if(I15.close<=I15.ema21&&dist21<=0.9)add("SELL",10,"M15 bearish pullback/value area");

  const last=m5.at(-1),prev=m5.at(-2);
  const bullCandle=Number(last.c)>Number(last.o)&&Number(last.c)>Number(prev.h);
  const bearCandle=Number(last.c)<Number(last.o)&&Number(last.c)<Number(prev.l);
  if(I5.ema9>I5.ema21&&bullCandle)add("BUY",15,"M5 bullish displacement confirmation");
  else if(I5.ema9>I5.ema21)add("BUY",8,"M5 bullish EMA trigger");
  if(I5.ema9<I5.ema21&&bearCandle)add("SELL",15,"M5 bearish displacement confirmation");
  else if(I5.ema9<I5.ema21)add("SELL",8,"M5 bearish EMA trigger");

  if(I5.rsi>=52&&I5.rsi<=72&&A5.adx>=20&&A5.plusDI>A5.minusDI)add("BUY",10,"M5 RSI/ADX momentum aligned");
  else if(I5.rsi>=50&&A5.plusDI>A5.minusDI)add("BUY",5,"M5 momentum partially aligned");
  if(I5.rsi<=48&&I5.rsi>=28&&A5.adx>=20&&A5.minusDI>A5.plusDI)add("SELL",10,"M5 RSI/ADX momentum aligned");
  else if(I5.rsi<=50&&A5.minusDI>A5.plusDI)add("SELL",5,"M5 momentum partially aligned");

  const recent=m5.slice(-20); const avgRange=mean(recent.map(b=>Number(b.h)-Number(b.l)));
  if(Number.isFinite(avgRange)&&I5.atr>=avgRange*0.7&&I5.atr<=avgRange*2.2){add("BUY",5,"M5 volatility tradable");add("SELL",5,"M5 volatility tradable");}

  if(sessionOk(symbol)&&spreadOk(symbol,lastQuote)){add("BUY",5,"session/spread acceptable");add("SELL",5,"session/spread acceptable");}

  const side=sideScores.BUY>=sideScores.SELL?"BUY":"SELL",other=side==="BUY"?"SELL":"BUY";
  const score=sideScores[side],edge=score-sideScores[other];
  if(score<MIN_SCORE)return{ok:false,reason:`best setup ${score}/100 below ${MIN_SCORE}`,side,score,edge,buyScore:sideScores.BUY,sellScore:sideScores.SELL};
  if(edge<15)return{ok:false,reason:`directional edge ${edge} below 15`,side,score,edge,buyScore:sideScores.BUY,sellScore:sideScores.SELL};

  const entry=Number(lastQuote?.mid||I5.close),atr=I5.atr; const sw=structureSnapshot(m5);
  let stop;
  if(side==="BUY"){
    const swing=sw.ready?sw.lastLow.p:entry-atr;
    stop=Math.min(swing-0.15*atr,entry-1.15*atr);
  }else{
    const swing=sw.ready?sw.lastHigh.p:entry+atr;
    stop=Math.max(swing+0.15*atr,entry+1.15*atr);
  }
  let risk=Math.abs(entry-stop); if(!Number.isFinite(risk)||risk<=0)risk=1.25*atr;
  const maxRisk=2.5*atr,minRisk=0.8*atr; risk=clamp(risk,minRisk,maxRisk); stop=side==="BUY"?entry-risk:entry+risk;
  const tp1=side==="BUY"?entry+risk:entry-risk;
  const tp2=side==="BUY"?entry+TARGET_R_MULTIPLE*risk:entry-TARGET_R_MULTIPLE*risk;
  const tp3=side==="BUY"?entry+3*risk:entry-3*risk;
  return{ok:true,symbol,side,score,edge,buyScore:sideScores.BUY,sellScore:sideScores.SELL,entry,stop,tp1,tp2,tp3,risk,rr:TARGET_R_MULTIPLE,reasons:reasons[side],atr,rsi:I5.rsi,adx:A5.adx,generatedAt:Date.now()};
}

export class MarketHub extends DurableObject{
  constructor(ctx,env){
    super(ctx,env); this.ctx=ctx; this.env=env;
    this.fxWs=null; this.cryptoWs=null; this.fxStatus="starting"; this.cryptoStatus="starting"; this.connectingFx=false; this.connectingCrypto=false;
    this.ticks=new Map(); this.quotes=new Map(); this.base5m=new Map(); this.pending=[]; this.history=[]; this.stats={wins:0,losses:0,timeouts:0};
    this.lastFxMsg=0; this.lastCryptoMsg=0; this.quotaBlockedUntil=0;
    this.ctx.blockConcurrencyWhile(async()=>{
      this.pending=(await this.ctx.storage.get("pending"))||[];
      this.history=(await this.ctx.storage.get("history"))||[];
      this.stats=(await this.ctx.storage.get("stats"))||this.stats;
      this.quotaBlockedUntil=Number((await this.ctx.storage.get("quotaBlockedUntil"))||0);
      await this.ensureSockets(); await this.scheduleAlarm();
    });
  }
  pushTick(symbol,t,p,bid=null,ask=null){
    if(!SYMBOLS.includes(symbol)||!Number.isFinite(t)||!Number.isFinite(p))return;
    const arr=this.ticks.get(symbol)||[]; arr.push({t,p,r:Date.now()}); while(arr.length>12000)arr.shift(); this.ticks.set(symbol,arr);
    const mid=Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:p; this.quotes.set(symbol,{t,p,mid,bid,ask,receivedAt:Date.now()});
  }
  async ensureSockets(){await Promise.all([this.ensureFx(),this.ensureCrypto()]);}
  async ensureFx(force=false){
    if(!force&&this.fxWs&&this.fxWs.readyState===1)return; if(this.connectingFx)return;
    const key=String(this.env.TIINGO_API_TOKEN||"").trim(); if(!key){this.fxStatus="missing TIINGO_API_TOKEN";return;}
    this.connectingFx=true;
    try{
      const ws=new WebSocket("wss://api.tiingo.com/fx"); this.fxWs=ws;
      ws.addEventListener("open",()=>{this.connectingFx=false;this.fxStatus="connected";this.lastFxMsg=Date.now();ws.send(JSON.stringify({eventName:"subscribe",authorization:key,eventData:{thresholdLevel:5,tickers:FX_SYMBOLS.map(tiingoTicker)}}));});
      ws.addEventListener("message",ev=>this.onFxMessage(ev));
      ws.addEventListener("close",()=>{if(this.fxWs===ws)this.fxWs=null;this.connectingFx=false;this.fxStatus="closed";});
      ws.addEventListener("error",()=>{this.fxStatus="websocket error";});
    }catch(e){this.connectingFx=false;this.fxWs=null;this.fxStatus=String(e?.message||e);}
  }
  onFxMessage(ev){
    this.lastFxMsg=Date.now();
    try{
      const x=JSON.parse(String(ev.data||"{}")); if(x.messageType==="I"){this.fxStatus=x?.response?.message||"subscribed";return;} if(x.messageType==="H")return; if(x.messageType==="E"){this.fxStatus=x?.response?.message||"subscription error";return;}
      if(x.messageType!=="A"||x.service!=="fx"||!Array.isArray(x.data)||x.data[0]!=="Q")return;
      const d=x.data,symbol=fromTicker(d[1]),t=Date.parse(String(d[2]||"")),bid=Number(d[4]),mid=Number(d[5]),ask=Number(d[7]); const p=Number.isFinite(mid)?mid:(Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:NaN);
      this.pushTick(symbol,t,p,bid,ask);
    }catch(_){}
  }
  async ensureCrypto(force=false){
    if(!force&&this.cryptoWs&&this.cryptoWs.readyState===1)return; if(this.connectingCrypto)return;
    const key=String(this.env.TIINGO_API_TOKEN||"").trim(); if(!key){this.cryptoStatus="missing TIINGO_API_TOKEN";return;}
    this.connectingCrypto=true;
    try{
      const ws=new WebSocket("wss://api.tiingo.com/crypto"); this.cryptoWs=ws;
      ws.addEventListener("open",()=>{this.connectingCrypto=false;this.cryptoStatus="connected";this.lastCryptoMsg=Date.now();ws.send(JSON.stringify({eventName:"subscribe",authorization:key,eventData:{thresholdLevel:5,tickers:CRYPTO_SYMBOLS.map(tiingoTicker)}}));});
      ws.addEventListener("message",ev=>this.onCryptoMessage(ev));
      ws.addEventListener("close",()=>{if(this.cryptoWs===ws)this.cryptoWs=null;this.connectingCrypto=false;this.cryptoStatus="closed";});
      ws.addEventListener("error",()=>{this.cryptoStatus="websocket error";});
    }catch(e){this.connectingCrypto=false;this.cryptoWs=null;this.cryptoStatus=String(e?.message||e);}
  }
  onCryptoMessage(ev){
    this.lastCryptoMsg=Date.now();
    try{
      const x=JSON.parse(String(ev.data||"{}")); if(x.messageType==="I"){this.cryptoStatus=x?.response?.message||"subscribed";return;} if(x.messageType==="H")return; if(x.messageType==="E"){this.cryptoStatus=x?.response?.message||"subscription error";return;}
      if(x.messageType!=="A"||x.service!=="crypto_data"||!Array.isArray(x.data))return; const d=x.data,symbol=fromTicker(d[1]),t=Date.parse(String(d[2]||""));
      let p=NaN,bid=null,ask=null;
      if(d[0]==="T")p=Number(d[5]);
      else if(d[0]==="Q"){bid=Number(d[5]);const mid=Number(d[6]);ask=Number(d[8]);p=Number.isFinite(mid)?mid:(Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:NaN);}
      this.pushTick(symbol,t,p,bid,ask);
    }catch(_){}
  }
  async forceReconnect(){try{this.fxWs?.close(1000,"reconnect");}catch(_){}try{this.cryptoWs?.close(1000,"reconnect");}catch(_){}this.fxWs=null;this.cryptoWs=null;this.connectingFx=false;this.connectingCrypto=false;await sleep(100);await this.ensureSockets();}
  async fetchHistorical5m(symbol){
    let cached=this.base5m.get(symbol);
    if(!cached){
      const saved=await this.ctx.storage.get(`bars5m:${symbol}`);
      if(saved&&Array.isArray(saved.bars)){cached=saved;this.base5m.set(symbol,saved);}
    }
    const live=buildBarsFromTicks(this.ticks.get(symbol)||[],300000);
    const cachedLast=Number(cached?.bars?.at(-1)?.t||0);
    const cacheFresh=cachedLast>0&&(Date.now()-cachedLast)<30*60*1000;
    if(cached&&cached.bars?.length>=120&&cacheFresh){return mergeBars(cached.bars,live);}
    if(this.quotaBlockedUntil>Date.now())throw new Error("Tiingo hourly request quota temporarily exhausted");
    const key=String(this.env.TIINGO_API_TOKEN||"").trim(); if(!key)throw new Error("missing TIINGO_API_TOKEN");
    const start=new Date(Date.now()-6*24*60*60*1000).toISOString().slice(0,10); let url;
    if(symbol==="BTC/USD"){
      url=new URL("https://api.tiingo.com/tiingo/crypto/prices"); url.searchParams.set("tickers",tiingoTicker(symbol)); url.searchParams.set("startDate",start); url.searchParams.set("resampleFreq","5min");
    }else{
      url=new URL(`https://api.tiingo.com/tiingo/fx/${tiingoTicker(symbol)}/prices`); url.searchParams.set("startDate",start); url.searchParams.set("resampleFreq","5min");
    }
    const r=await fetch(url.toString(),{headers:{accept:"application/json",authorization:`Token ${key}`}}); let data=null; try{data=await r.json();}catch(_){}
    if(!r.ok){const msg=String(data?.detail||data?.message||`Tiingo ${r.status}`);if(/hourly|limit|allocation/i.test(msg)){this.quotaBlockedUntil=(Math.floor(Date.now()/3600000)+1)*3600000+60000;await this.ctx.storage.put("quotaBlockedUntil",this.quotaBlockedUntil);}throw new Error(msg);}
    let rows;
    if(symbol==="BTC/USD")rows=Array.isArray(data)&&data[0]&&Array.isArray(data[0].priceData)?data[0].priceData:[]; else rows=Array.isArray(data)?data:[];
    const current=Math.floor(Date.now()/300000)*300000;
    const bars=rows.map(v=>({t:Date.parse(String(v.date||"")),o:Number(v.open),h:Number(v.high),l:Number(v.low),c:Number(v.close),n:1})).filter(b=>Number.isFinite(b.t)&&[b.o,b.h,b.l,b.c].every(Number.isFinite)&&b.t<current).sort((a,b)=>a.t-b.t).slice(-1500);
    if(bars.length<120)throw new Error(`only ${bars.length} completed 5m bars available`);
    const pack={at:Date.now(),bars};
    this.base5m.set(symbol,pack);
    await this.ctx.storage.put(`bars5m:${symbol}`,pack);
    return mergeBars(bars,live);
  }
  async analyze(symbol){
    symbol=normalizeSymbol(symbol); if(!symbol)return{ok:false,error:"invalid symbol"}; await this.ensureSockets();
    let bars5; try{bars5=await this.fetchHistorical5m(symbol);}catch(e){return{ok:false,symbol,reason:String(e?.message||e)};}
    const bars15=resampleBars(bars5,900000).slice(-400),h1=resampleBars(bars5,3600000).slice(-160); const quote=this.quotes.get(symbol)||{mid:Number(bars5.at(-1)?.c)};
    if(symbol!=="BTC/USD"&&!sessionOk(symbol))return{ok:false,symbol,reason:"outside London/New York day-trading window"};
    const result=scoreSetup(symbol,bars5,bars15,h1,quote); return{...result,symbol,lastQuote:quote,frames:{M5:bars5.length,M15:bars15.length,H1:h1.length},generatedAt:Date.now()};
  }
  async track(payload){
    const symbol=normalizeSymbol(payload.symbol),side=String(payload.side||"").toUpperCase(),entry=Number(payload.entry),stop=Number(payload.stop),tp2=Number(payload.tp2),chatId=payload.chatId;
    if(!symbol||!["BUY","SELL"].includes(side)||![entry,stop,tp2].every(Number.isFinite)||!chatId)return{ok:false,error:"invalid trade payload"};
    const id=crypto.randomUUID(),now=Date.now(); const trade={id,symbol,side,entry,stop,tp2,chatId,openedAt:now,expiresAt:now+MAX_HOLD_MINUTES*60000,sourceUpdateId:String(payload.sourceUpdateId||"")};
    this.pending.push(trade); await this.ctx.storage.put("pending",this.pending); await this.scheduleAlarm(); return{ok:true,id};
  }
  async send(chatId,text){const token=String(this.env.TELEGRAM_BOT_TOKEN||"").trim();if(!token)return;try{await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});}catch(_){}}
  async settle(){
    if(!this.pending.length)return; const now=Date.now(),keep=[];
    for(const t of this.pending){
      const q=this.quotes.get(t.symbol); const p=Number(q?.mid||q?.p); if(!Number.isFinite(p)){keep.push(t);continue;}
      let result=null;
      if(t.side==="BUY"&&p<=t.stop)result="LOSS"; if(t.side==="SELL"&&p>=t.stop)result="LOSS";
      if(t.side==="BUY"&&p>=t.tp2)result="WIN"; if(t.side==="SELL"&&p<=t.tp2)result="WIN";
      if(!result&&now>=t.expiresAt)result="TIMEOUT";
      if(!result){keep.push(t);continue;}
      if(result==="WIN")this.stats.wins++; else if(result==="LOSS")this.stats.losses++; else this.stats.timeouts++;
      const rec={...t,result,exit:p,closedAt:now}; this.history=[rec,...this.history].slice(0,100);
      const icon=result==="WIN"?"✅":result==="LOSS"?"❌":"⌛";
      await this.send(t.chatId,`${icon} ${t.symbol} ${t.side} — ${result}\nEntry: ${formatPrice(t.symbol,t.entry)}\nExit: ${formatPrice(t.symbol,p)}\nTracked target: 2R`);
    }
    this.pending=keep; await this.ctx.storage.put("pending",keep); await this.ctx.storage.put("history",this.history); await this.ctx.storage.put("stats",this.stats);
  }
  async scheduleAlarm(){await this.ctx.storage.setAlarm(Date.now()+30000);}
  async alarm(){try{await this.ensureSockets();if(this.lastFxMsg&&Date.now()-this.lastFxMsg>60000)await this.ensureFx(true);if(this.lastCryptoMsg&&Date.now()-this.lastCryptoMsg>60000)await this.ensureCrypto(true);await this.settle();}catch(_){}await this.scheduleAlarm();}
  async fetch(req){
    const u=new URL(req.url),symbol=normalizeSymbol(u.searchParams.get("symbol"));
    if(u.pathname==="/analyze")return json(await this.analyze(symbol));
    if(u.pathname==="/track"&&req.method==="POST")return json(await this.track(await req.json()));
    if(u.pathname==="/stats"){const resolved=this.stats.wins+this.stats.losses;return json({ok:true,...this.stats,pending:this.pending.length,winRate:resolved?100*this.stats.wins/resolved:null,recent:this.history.slice(0,8)});}
    if(u.pathname==="/status"){
      const rows=SYMBOLS.map(s=>{const q=this.quotes.get(s),age=q?Math.max(0,(Date.now()-q.receivedAt)/1000):null;return{symbol:s,ageSeconds:age,live:age!=null&&age<30,price:q?.mid??q?.p??null};});
      return json({ok:true,version:VERSION,fxStatus:this.fxStatus,cryptoStatus:this.cryptoStatus,fxConnected:Boolean(this.fxWs&&this.fxWs.readyState===1),cryptoConnected:Boolean(this.cryptoWs&&this.cryptoWs.readyState===1),symbols:rows});
    }
    if(u.pathname==="/reconnect"){await this.forceReconnect();return json({ok:true,fxStatus:this.fxStatus,cryptoStatus:this.cryptoStatus});}
    return json({ok:true,version:VERSION});
  }
}

async function tgSend(env,chatId,text){
  const token=String(env.TELEGRAM_BOT_TOKEN||"").trim(); if(!token)throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true,reply_markup:{remove_keyboard:true}})});
  if(!r.ok)throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}
function hubStub(env){const id=env.MARKET_HUB.idFromName("global-daytrader-feed");return env.MARKET_HUB.get(id);}
async function hubGet(env,path){const r=await hubStub(env).fetch(`https://hub${path}`);return r.json();}
async function hubPost(env,path,body){const r=await hubStub(env).fetch(`https://hub${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return r.json();}
async function scanUniverse(env){
  const checked=[];
  for(const symbol of SYMBOLS){try{checked.push(await hubGet(env,`/analyze?symbol=${encodeURIComponent(symbol)}`));}catch(e){checked.push({ok:false,symbol,reason:String(e?.message||e)});}}
  const qualified=checked.filter(x=>x?.ok&&Number.isFinite(Number(x.score))).sort((a,b)=>Number(b.score)-Number(a.score)||Number(b.edge)-Number(a.edge));
  return qualified.length?{ok:true,best:qualified[0],checked}:{ok:false,checked,reason:"No qualifying setup"};
}
function setupMessage(x){
  const dir=x.side==="BUY"?"🟢 BUY":"🔴 SELL";
  return `${dir} — ${x.symbol}\n\nEntry: ${formatPrice(x.symbol,x.entry)}\nStop Loss: ${formatPrice(x.symbol,x.stop)}\nTP1 (1R): ${formatPrice(x.symbol,x.tp1)}\nTP2 (2R): ${formatPrice(x.symbol,x.tp2)}\nTP3 (3R): ${formatPrice(x.symbol,x.tp3)}\n\nSetup score: ${x.score}/100\nDirectional edge: ${x.edge}\nM5 RSI: ${Number(x.rsi).toFixed(1)}\nM5 ADX: ${Number(x.adx).toFixed(1)}\n\nRisk rule: size the position so the stop equals no more than your chosen account-risk %.\nTracking target: TP2 (2R).`;
}

export default{
  async fetch(request,env){
    const u=new URL(request.url);
    if(u.pathname==="/health")return json({ok:true,version:VERSION,symbols:SYMBOLS,minScore:MIN_SCORE});
    if(request.method!=="POST")return new Response(`Forex Day Trader ${VERSION}`,{status:200});
    if(u.pathname!=="/telegram")return new Response("Not found",{status:404});
    const secret=String(env.TELEGRAM_WEBHOOK_SECRET||"").trim(); if(secret&&request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==secret)return new Response("forbidden",{status:403});
    const update=await request.json(),msg=update.message||update.edited_message; if(!msg?.chat?.id)return new Response("ok");
    const chatId=msg.chat.id,text=String(msg.text||"").trim();
    if(/^\/start$/i.test(text)){await tgSend(env,chatId,`FOREX DAY TRADER V1\n\nUse /signal to scan all 8 markets:\nEUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, XAU/USD, BTC/USD\n\nOnly qualifying setups are returned. No forced trades.`);return new Response("ok");}
    if(/^\/version$/i.test(text)){await tgSend(env,chatId,VERSION);return new Response("ok");}
    if(/^\/checkall$/i.test(text)){
      const s=await hubGet(env,"/status"); const lines=s.symbols.map(x=>`${x.live?"🟢":"⚪"} ${x.symbol} — ${x.live?"LIVE":"NO FRESH TICK"}${x.ageSeconds==null?"":` • ${x.ageSeconds.toFixed(1)}s`}`);
      await tgSend(env,chatId,`MARKET FEED HEALTH\nFX: ${s.fxStatus}\nBTC: ${s.cryptoStatus}\n\n${lines.join("\n")}`);return new Response("ok");
    }
    if(/^\/stats$/i.test(text)){
      const s=await hubGet(env,"/stats"),wr=s.winRate==null?"n/a":`${Number(s.winRate).toFixed(1)}%`;
      await tgSend(env,chatId,`DAY-TRADE STATS\nWins: ${s.wins}\nLosses: ${s.losses}\nTimeouts: ${s.timeouts}\nPending: ${s.pending}\nWin rate (2R vs SL): ${wr}`);return new Response("ok");
    }
    if(/^\/reconnect$/i.test(text)){const s=await hubGet(env,"/reconnect");await tgSend(env,chatId,`Reconnect requested.\nFX: ${s.fxStatus}\nBTC: ${s.cryptoStatus}`);return new Response("ok");}
    if(/^\/signal\s*$/i.test(text)){
      const scan=await scanUniverse(env);
      if(!scan.ok){
        const reasons=scan.checked.slice(0,8).map(x=>`${x.symbol}: ${x.reason||"not qualified"}`).join("\n");
        await tgSend(env,chatId,`⏳ NO QUALIFIED DAY-TRADE SETUP\n\nThe bot scanned all 8 markets and did not force a trade.\n\n${reasons}`);return new Response("ok");
      }
      const x=scan.best; await tgSend(env,chatId,setupMessage(x));
      await hubPost(env,"/track",{sourceUpdateId:update.update_id,chatId,symbol:x.symbol,side:x.side,entry:x.entry,stop:x.stop,tp2:x.tp2}); return new Response("ok");
    }
    if(/^\/signal\b/i.test(text)){await tgSend(env,chatId,"Use /signal by itself. V1 scans all 8 markets and returns only the strongest qualifying setup.");return new Response("ok");}
    return new Response("ok");
  }
};
