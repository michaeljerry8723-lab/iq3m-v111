const div=(a,b)=>b?Number(a)/Number(b):null;
function longest(signals,result){
  let best=0,cur=0;
  for(const s of signals){
    if(s.result===result){cur++;best=Math.max(best,cur);}
    else if(["WIN","LOSS"].includes(s.result))cur=0;
  }
  return best;
}
function grouped(signals,keyFn){
  const groups={};
  for(const s of signals){const k=String(keyFn(s));(groups[k]??=[]).push(s);}
  const out={};
  for(const [k,rows] of Object.entries(groups)){
    const wins=rows.filter(x=>x.result==="WIN").length,losses=rows.filter(x=>x.result==="LOSS").length,draws=rows.filter(x=>x.result==="DRAW").length;
    out[k]={signals:rows.length,wins,losses,draws,winRateExcludingDraws:div(wins,wins+losses)};
  }
  return out;
}
const session=h=>h<7?"ASIA":h<13?"LONDON":h<21?"NEW_YORK":"LATE";
export function calculateMetrics({mode,period,signals,prepares,rejections,tradingDays}){
  const wins=signals.filter(x=>x.result==="WIN").length,losses=signals.filter(x=>x.result==="LOSS").length,draws=signals.filter(x=>x.result==="DRAW").length,voids=signals.filter(x=>x.result==="VOID").length;
  const filterRejections={};for(const r of rejections)filterRejections[r.filter]=(filterRejections[r.filter]||0)+1;
  return {
    mode,period,tradingDays,totalPrepareSetups:prepares.length,totalTestableSignals:signals.length,
    prepareToCandidateRate:div(signals.length,prepares.length),wins,losses,draws,voids,
    winRateExcludingDraws:div(wins,wins+losses),winRateIncludingDraws:div(wins,wins+losses+draws),
    signalsPerDay:div(signals.length,tradingDays),longestWinningStreak:longest(signals,"WIN"),longestLosingStreak:longest(signals,"LOSS"),
    byPair:grouped(signals,x=>x.symbol),byDirection:grouped(signals,x=>x.direction),byMonth:grouped(signals,x=>x.month),
    byHourUtc:grouped(signals,x=>new Date(x.entryAt).getUTCHours()),bySessionUtc:grouped(signals,x=>session(new Date(x.entryAt).getUTCHours())),
    filterRejections
  };
}
export function splitSamples(months){
  const cut=Math.max(1,Math.floor(months.length*2/3));
  return {development:months.slice(0,cut),holdout:months.slice(cut)};
}
export function csv(rows){
  if(!rows.length)return "";
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const esc=v=>{if(v==null)return "";const s=typeof v==="object"?JSON.stringify(v):String(v);return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
  return keys.join(",")+"\n"+rows.map(r=>keys.map(k=>esc(r[k])).join(",")).join("\n")+"\n";
}
