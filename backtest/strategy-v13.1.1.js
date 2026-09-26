/**
 * Chronological OHLC-only extraction of the production V13.1.1 core.
 * This intentionally stops before genuine 30-second/live-tick confirmation.
 */
export const VERSION="13.1.1-ready-guarantee";
export const STRATEGY_ID="v13.1.1-two-minute-ready-guarantee";
export const SYMBOLS=["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","USD/CHF"];
export const EXPIRY_MS=120000;
export const PREPARE_TTL_MS=300000;
export const PAIR_COOLDOWN_MS=480000;
export const LOSS_CIRCUIT_BREAKER_MS=1200000;
export const A_GRADE_MIN_QUALITY=0.90;

const mean=xs=>xs.length?xs.reduce((a,b)=>a+Number(b),0)/xs.length:NaN;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));

export function smaSeries(vals,p){
  const out=new Array(vals.length).fill(NaN);let sum=0;
  for(let i=0;i<vals.length;i++){sum+=+vals[i];if(i>=p)sum-=+vals[i-p];if(i>=p-1)out[i]=sum/p;}
  return out;
}
export function emaSeries(vals,p){
  const out=new Array(vals.length).fill(NaN);if(vals.length<p)return out;
  out[p-1]=mean(vals.slice(0,p));const k=2/(p+1);
  for(let i=p;i<vals.length;i++)out[i]=+vals[i]*k+out[i-1]*(1-k);
  return out;
}
export function aggregateCompleted(bars,seconds,decisionAt){
  const span=seconds*1000,m=new Map();
  for(const b of bars){
    if(+b.t+60000>decisionAt)throw new Error(`lookahead bar ${b.t} at ${decisionAt}`);
    const bucket=Math.floor(+b.t/span)*span;let x=m.get(bucket);
    if(!x){x={t:bucket,o:+b.o,h:+b.h,l:+b.l,c:+b.c,n:+(b.n||1)};m.set(bucket,x);}
    else{x.h=Math.max(x.h,+b.h);x.l=Math.min(x.l,+b.l);x.c=+b.c;x.n+=+(b.n||1);}
  }
  return [...m.values()].filter(b=>b.t+span<=decisionAt).sort((a,b)=>a.t-b.t);
}
export function atrSnapshot(bars,p=14){
  if(bars.length<p+1)return {ready:false};let sum=0;const xs=bars.slice(-(p+1));
  for(let i=1;i<xs.length;i++)sum+=Math.max(+xs[i].h-+xs[i].l,Math.abs(+xs[i].h-+xs[i-1].c),Math.abs(+xs[i].l-+xs[i-1].c));
  return {ready:true,atr:sum/p};
}
export function smaTrendSnapshot(bars,fast=5,slow=13){
  if(bars.length<slow+2)return {ready:false};
  const c=bars.map(b=>+b.c),sf=smaSeries(c,fast),ss=smaSeries(c,slow),i=c.length-1;
  if(![sf[i],sf[i-1],ss[i],ss[i-1]].every(Number.isFinite))return {ready:false};
  return {ready:true,fast:sf[i],slow:ss[i],prevFast:sf[i-1],prevSlow:ss[i-1],fastSlope:sf[i]-sf[i-1],slowSlope:ss[i]-ss[i-1]};
}
export function fractalSnapshot(bars,p=2){
  if(bars.length<p*2+3)return {ready:false};let lastHigh=null,lastLow=null;
  for(let i=p;i<bars.length-p;i++){
    let high=true,low=true;
    for(let k=1;k<=p;k++){
      if(!(bars[i].h>bars[i-k].h&&bars[i].h>bars[i+k].h))high=false;
      if(!(bars[i].l<bars[i-k].l&&bars[i].l<bars[i+k].l))low=false;
    }
    if(high)lastHigh={price:+bars[i].h,t:+bars[i].t,confirmedAt:+bars[i+p].t+60000};
    if(low)lastLow={price:+bars[i].l,t:+bars[i].t,confirmedAt:+bars[i+p].t+60000};
  }
  return {ready:Boolean(lastHigh||lastLow),lastHigh,lastLow,period:p};
}
export function efficiencyRatio(bars,p=8){
  if(bars.length<p+1)return 0;const xs=bars.slice(-(p+1)).map(b=>+b.c);let travel=0;
  for(let i=1;i<xs.length;i++)travel+=Math.abs(xs[i]-xs[i-1]);
  return travel?Math.abs(xs.at(-1)-xs[0])/travel:0;
}
export function trendRegime(bars,fast=5,slow=13,minEfficiency=.20){
  if(bars.length<slow+3)return {ready:false,direction:"NEUTRAL",efficiency:0};
  const c=bars.map(b=>+b.c),sf=smaSeries(c,fast),ss=smaSeries(c,slow),i=c.length-1,efficiency=efficiencyRatio(bars,Math.min(8,bars.length-1));
  let direction="NEUTRAL";
  if(sf[i]>ss[i]&&sf[i]>=sf[i-1]&&efficiency>=minEfficiency)direction="CALL";
  if(sf[i]<ss[i]&&sf[i]<=sf[i-1]&&efficiency>=minEfficiency)direction="PUT";
  return {ready:true,direction,efficiency,fast:sf[i],slow:ss[i]};
}
export function macdSnapshot(bars,fast=5,slow=13,signal=4){
  if(bars.length<slow+signal+3)return {ready:false};
  const c=bars.map(b=>+b.c),ef=emaSeries(c,fast),es=emaSeries(c,slow),m=[];
  for(let i=0;i<c.length;i++)if(Number.isFinite(ef[i])&&Number.isFinite(es[i]))m.push(ef[i]-es[i]);
  if(m.length<signal+3)return {ready:false};const sig=emaSeries(m,signal),i=m.length-1;
  return {ready:true,macd:m[i],signal:sig[i],hist:m[i]-sig[i],prevHist:m[i-1]-sig[i-1]};
}
export function rsiSnapshot(bars,p=7){
  if(bars.length<p+2)return {ready:false};const c=bars.map(b=>+b.c);let gains=0,losses=0;
  for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return {ready:true,rsi:100};const rs=(gains/p)/(losses/p);return {ready:true,rsi:100-100/(1+rs)};
}
export function aroonSnapshot(bars,p=14){
  if(bars.length<p+1)return {ready:false};const xs=bars.slice(-p);let hi=-Infinity,lo=Infinity,hiIdx=0,loIdx=0;
  xs.forEach((b,i)=>{if(+b.h>=hi){hi=+b.h;hiIdx=i;}if(+b.l<=lo){lo=+b.l;loIdx=i;}});
  return {ready:true,up:100*(p-(p-1-hiIdx))/p,down:100*(p-(p-1-loIdx))/p};
}
export function dmiAdxSnapshot(bars,p=7){
  if(bars.length<p*2+2)return {ready:false};const trs=[],plus=[],minus=[];
  for(let i=1;i<bars.length;i++){
    const h=+bars[i].h,l=+bars[i].l,ph=+bars[i-1].h,pl=+bars[i-1].l,pc=+bars[i-1].c,up=h-ph,dn=pl-l;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));plus.push(up>dn&&up>0?up:0);minus.push(dn>up&&dn>0?dn:0);
  }
  const dx=[];
  for(let i=p-1;i<trs.length;i++){
    let tr=0,pdm=0,mdm=0;
    for(let j=i-p+1;j<=i;j++){tr+=trs[j];pdm+=plus[j];mdm+=minus[j];}
    if(tr<=0){dx.push(NaN);continue;}
    const pdi=100*pdm/tr,mdi=100*mdm/tr;dx.push(pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  }
  const valid=dx.filter(Number.isFinite);if(valid.length<p)return {ready:false};
  let tr=0,pdm=0,mdm=0;for(let j=trs.length-p;j<trs.length;j++){tr+=trs[j];pdm+=plus[j];mdm+=minus[j];}
  return tr>0?{ready:true,adx:mean(valid.slice(-p)),plusDI:100*pdm/tr,minusDI:100*mdm/tr}:{ready:false};
}
const candlePressure=(bars,n=3)=>{
  const xs=bars.slice(-n);if(xs.length<n)return {ready:false};let bull=0,bear=0;
  for(const b of xs){if(+b.c>+b.o)bull++;else if(+b.c<+b.o)bear++;}
  return {ready:true,bull,bear};
};
export function roomToMoveSnapshot(bars,last,direction,atr,decisionAt){
  const b15=aggregateCompleted(bars,900,decisionAt).slice(-24);
  if(b15.length<6||!(atr>0))return {ready:false,roomAtr:0};
  const levels=b15.map(b=>direction==="CALL"?+b.h:+b.l).filter(x=>direction==="CALL"?x>last:x<last);
  if(!levels.length)return {ready:true,roomAtr:Infinity,level:null};
  const level=direction==="CALL"?Math.min(...levels):Math.max(...levels);
  return {ready:true,roomAtr:direction==="CALL"?(level-last)/atr:(last-level)/atr,level};
}
export function sequenceSnapshot(bars,decisionAt){
  const sma=smaTrendSnapshot(bars),fr=fractalSnapshot(bars,2),atr=atrSnapshot(bars,14);
  const reg5=trendRegime(aggregateCompleted(bars,300,decisionAt));
  if(!sma.ready||!fr.ready||!atr.ready||!reg5.ready)return {ready:false,direction:"NEUTRAL",barT:+(bars.at(-1)?.t||0)};
  const direction=reg5.direction,lastBar=bars.at(-1);
  if(direction==="NEUTRAL")return {ready:true,direction,barT:+lastBar.t};
  const last=+lastBar.c,structureOk=direction==="CALL"?(!fr.lastLow||last>fr.lastLow.price):(!fr.lastHigh||last<fr.lastHigh.price);
  const zoneLow=Math.min(sma.fast,sma.slow)-.18*atr.atr,zoneHigh=Math.max(sma.fast,sma.slow)+.18*atr.atr;
  const pullbackSeen=bars.slice(-4).some(b=>+b.l<=zoneHigh&&+b.h>=zoneLow);
  return {ready:true,direction,barT:+lastBar.t,structureOk,pullbackSeen,atr:atr.atr,regimeEfficiency:reg5.efficiency};
}
export function preliminaryCore(bars,symbol,direction,decisionAt){
  const seq=sequenceSnapshot(bars,decisionAt);
  if(!seq.ready||seq.direction!==direction||!seq.structureOk||!seq.pullbackSeen)return {ok:false,filter:"prepare_structure"};
  const sma=smaTrendSnapshot(bars),atr=atrSnapshot(bars),dmi=dmiAdxSnapshot(bars),fr=fractalSnapshot(bars);
  const reg5=trendRegime(aggregateCompleted(bars,300,decisionAt)),reg15=trendRegime(aggregateCompleted(bars,900,decisionAt),3,8,.18);
  if(!sma.ready||!atr.ready||!fr.ready||!dmi.ready||!reg5.ready)return {ok:false,filter:"prepare_context"};
  const last=+bars.at(-1).c,atrRatio=atr.atr/last;if(atrRatio<.000008||atrRatio>.0028)return {ok:false,filter:"volatility"};
  if(reg5.direction!==direction)return {ok:false,filter:"5m_direction"};
  if(reg15.ready&&reg15.direction!=="NEUTRAL"&&reg15.direction!==direction&&reg15.efficiency>=.30)return {ok:false,filter:"15m_veto"};
  const stack=direction==="CALL"?sma.fast>sma.slow:sma.fast<sma.slow,slope=direction==="CALL"?sma.fastSlope>=0:sma.fastSlope<=0;
  if(!stack||!slope)return {ok:false,filter:"sma_structure"};
  const gap=Math.abs(dmi.plusDI-dmi.minusDI),aligned=direction==="CALL"?dmi.plusDI>dmi.minusDI:dmi.minusDI>dmi.plusDI;
  if(!aligned||dmi.adx<20||gap<4)return {ok:false,filter:"adx_dmi"};
  const distanceFast=Math.abs(last-sma.fast)/atr.atr;if(distanceFast>.68)return {ok:false,filter:"distance_fast"};
  const room=roomToMoveSnapshot(bars,last,direction,atr.atr,decisionAt);if(!room.ready||room.roomAtr<.85)return {ok:false,filter:"room_to_move"};
  const preScore=clamp(.84+Math.min(Math.max(dmi.adx-20,0),15)/15*.035+Math.min(Math.max(room.roomAtr-.85,0),.75)/.75*.025+(reg15.ready&&reg15.direction===direction?.020:0)+(distanceFast<=.55?.015:0),.84,.94);
  if(preScore<.86)return {ok:false,filter:"prepare_score"};
  return {ok:true,preScore,adx:dmi.adx,roomAtr:room.roomAtr,distanceFastAtr:distanceFast,atrRatio,regime5Efficiency:reg5.efficiency,regime15:reg15.ready?reg15.direction:"NOT_READY"};
}
export function finalHistoricalCore(bars,symbol,direction,decisionAt){
  const sma=smaTrendSnapshot(bars),fr=fractalSnapshot(bars),macd=macdSnapshot(bars),aroon=aroonSnapshot(bars),atr=atrSnapshot(bars),rsi=rsiSnapshot(bars),dmi=dmiAdxSnapshot(bars),pressure=candlePressure(bars);
  const reg5=trendRegime(aggregateCompleted(bars,300,decisionAt)),reg15=trendRegime(aggregateCompleted(bars,900,decisionAt),3,8,.18),last=+bars.at(-1).c;
  if(!sma.ready||!fr.ready||!macd.ready||!aroon.ready||!atr.ready||!rsi.ready||!dmi.ready||!pressure.ready||!reg5.ready)return {ok:false,filter:"core_context"};
  if(reg5.direction!==direction)return {ok:false,filter:"5m_direction"};
  const atrRatio=atr.atr/last;if(atrRatio<.000008||atrRatio>.0028)return {ok:false,filter:"volatility"};
  if(reg15.ready&&reg15.direction!=="NEUTRAL"&&reg15.direction!==direction&&reg15.efficiency>=.30)return {ok:false,filter:"15m_veto"};
  const stack=direction==="CALL"?sma.fast>sma.slow:sma.fast<sma.slow,fastSlope=direction==="CALL"?sma.fastSlope>0:sma.fastSlope<0,slowSlope=direction==="CALL"?sma.slowSlope>=0:sma.slowSlope<=0;
  if(!stack||!fastSlope||!slowSlope)return {ok:false,filter:"sma_structure"};
  if((direction==="CALL"&&fr.lastLow&&last<=fr.lastLow.price)||(direction==="PUT"&&fr.lastHigh&&last>=fr.lastHigh.price))return {ok:false,filter:"fractal_structure"};
  const distanceFast=Math.abs(last-sma.fast)/atr.atr;if(distanceFast>.68)return {ok:false,filter:"distance_fast"};
  const room=roomToMoveSnapshot(bars,last,direction,atr.atr,decisionAt);if(!room.ready||room.roomAtr<.85)return {ok:false,filter:"room_to_move"};
  const gap=Math.abs(dmi.plusDI-dmi.minusDI),dmiAligned=direction==="CALL"?dmi.plusDI>dmi.minusDI:dmi.minusDI>dmi.plusDI;
  if(!dmiAligned||dmi.adx<20||gap<4)return {ok:false,filter:"adx_dmi"};
  const macdAligned=direction==="CALL"?macd.macd>macd.signal&&macd.hist>0&&macd.hist>=macd.prevHist:macd.macd<macd.signal&&macd.hist<0&&macd.hist<=macd.prevHist;
  if(!macdAligned)return {ok:false,filter:"macd"};
  const rsiAligned=direction==="CALL"?rsi.rsi>=52&&rsi.rsi<=69:rsi.rsi<=48&&rsi.rsi>=31;if(!rsiAligned)return {ok:false,filter:"rsi"};
  const aroonAligned=direction==="CALL"?aroon.up>aroon.down+15:aroon.down>aroon.up+15;if(!aroonAligned)return {ok:false,filter:"aroon"};
  const last1=bars.at(-1),continuation=direction==="CALL"?last1.c>last1.o&&last1.c>sma.fast:last1.c<last1.o&&last1.c<sma.fast;
  if(!continuation)return {ok:false,filter:"1m_continuation"};
  const pressureAligned=direction==="CALL"?pressure.bull>=2:pressure.bear>=2;if(!pressureAligned)return {ok:false,filter:"candle_pressure"};
  const quality=clamp(.895+(reg15.ready&&reg15.direction===direction?.012:0)+Math.min(Math.max(dmi.adx-20,0),15)/15*.018+Math.min(Math.max(room.roomAtr-.85,0),.75)/.75*.014+(distanceFast<=.45?.010:0),.895,.965);
  if(quality<A_GRADE_MIN_QUALITY)return {ok:false,filter:"a_grade_quality",quality};
  return {ok:true,direction,quality,adx:dmi.adx,roomAtr:room.roomAtr,distanceFastAtr:distanceFast,regime5Efficiency:reg5.efficiency,regime15:reg15.ready?reg15.direction:"NOT_READY",regime15Aligned:reg15.ready&&reg15.direction===direction,atrRatio,rsi:rsi.rsi,dmiGap:gap,entryPrice:last,decisionAt};
}
export function usdExposureSide(symbol,direction){
  const base=new Set(["USD/JPY","USD/CAD","USD/CHF"]),quote=new Set(["EUR/USD","GBP/USD","AUD/USD"]);
  if(base.has(symbol))return direction==="CALL"?"USD_LONG":"USD_SHORT";
  if(quote.has(symbol))return direction==="CALL"?"USD_SHORT":"USD_LONG";
  return null;
}
export function riskGate(history,now){
  const resolved=history.filter(x=>(x.result==="WIN"||x.result==="LOSS")&&x.settledAt<=now).sort((a,b)=>b.settledAt-a.settledAt);
  if(resolved.length>=2&&resolved[0].result==="LOSS"&&resolved[1].result==="LOSS"&&now-resolved[0].settledAt<LOSS_CIRCUIT_BREAKER_MS)return {ok:false,filter:"two_loss_circuit_breaker"};
  const last3=resolved.slice(0,3);
  if(last3.length===3&&last3.filter(x=>x.result==="LOSS").length>=2&&now-last3[0].settledAt<600000)return {ok:false,filter:"recent_performance_cooldown"};
  return {ok:true};
}
export function pairCooldown(history,symbol,now){
  const all=history.filter(x=>x.symbol===symbol&&x.entryAt<=now).sort((a,b)=>b.entryAt-a.entryAt);if(!all.length)return false;
  const resolved=all.filter(x=>(x.result==="WIN"||x.result==="LOSS")&&x.settledAt<=now);
  if(resolved.length>=2&&resolved[0].result==="LOSS"&&resolved[1].result==="LOSS"&&now-resolved[0].settledAt<1800000)return true;
  if(resolved[0]?.result==="LOSS"&&now-resolved[0].settledAt<720000)return true;
  return now-all[0].entryAt<PAIR_COOLDOWN_MS;
}
