// V11.1 — 15-second tick sniper with Cloudflare Durable Object
import { DurableObject } from "cloudflare:workers";

const VERSION = "11.5.0-tiingo-auto-track-six-scan";
const DEFAULT_SYMBOLS = "EUR/USD,USD/JPY,GBP/USD,USD/CAD,AUD/USD,USD/CHF";
const FIXED_UNIVERSE = DEFAULT_SYMBOLS.split(",");
const EXPIRY_SECONDS = 60;

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
function fractalSnapshot(bars){
  if(!bars || bars.length<7)return {ready:false};
  let lastHigh=null,lastLow=null;
  for(let i=2;i<bars.length-2;i++){
    const b=bars[i];
    if(Number(b.h)>Number(bars[i-1].h)&&Number(b.h)>Number(bars[i-2].h)&&Number(b.h)>Number(bars[i+1].h)&&Number(b.h)>Number(bars[i+2].h)) lastHigh={price:Number(b.h),t:b.t};
    if(Number(b.l)<Number(bars[i-1].l)&&Number(b.l)<Number(bars[i-2].l)&&Number(b.l)<Number(bars[i+1].l)&&Number(b.l)<Number(bars[i+2].l)) lastLow={price:Number(b.l),t:b.t};
  }
  return {ready:Boolean(lastHigh||lastLow),lastHigh,lastLow};
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

function emaTrendSnapshot(bars){
  if(!bars || bars.length<24)return {ready:false};
  const c=bars.map(b=>Number(b.c)), e9=emaSeries(c,9), e21=emaSeries(c,21), i=c.length-1;
  if(![e9[i],e9[i-1],e21[i],e21[i-1]].every(Number.isFinite))return {ready:false};
  return {ready:true,ema9:e9[i],ema21:e21[i],slope9:e9[i]-e9[i-1],slope21:e21[i]-e21[i-1]};
}
function parseUtcDateTime(v){
  const x=String(v||"").trim().replace(" ","T");
  if(!x)return NaN;
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(x)?x:x+"Z");
}

function score60s(ticks,bars1m){
  const bars15=buildBars(ticks,15), bars5=buildBars(ticks,5);
  if(bars15.length<6 || bars5.length<12){
    return {ok:false,reason:"micro-entry layer still warming",bars15:bars15.length,bars5:bars5.length};
  }

  const a1=alligatorSnapshot(bars1m);
  const m1=macdSnapshot(bars1m,5,13,4);
  const ar1=aroonSnapshot(bars1m,14);
  const fr1=fractalSnapshot(bars1m);
  const et1=emaTrendSnapshot(bars1m);
  if(!a1.ready||!m1.ready||!ar1.ready||!et1.ready){
    return {ok:false,reason:"1-minute context not ready",bars15:bars15.length,bars5:bars5.length};
  }

  const call={score:0,major:0,reasons:[]}, put={score:0,major:0,reasons:[]};
  const last=Number(ticks.at(-1)?.p), last1=bars1m.at(-1), prev1=bars1m.at(-2);

  if(a1.lips>a1.teeth&&a1.teeth>a1.jaws&&a1.lipsSlope>0&&a1.teethSlope>=0){
    call.score+=3;call.major++;call.reasons.push("1m Alligator bullish");
  }
  if(a1.lips<a1.teeth&&a1.teeth<a1.jaws&&a1.lipsSlope<0&&a1.teethSlope<=0){
    put.score+=3;put.major++;put.reasons.push("1m Alligator bearish");
  }
  if(a1.gap>a1.prevGap){
    if(a1.lips>a1.jaws){call.score+=0.7;call.reasons.push("1m Alligator expanding");}
    else if(a1.lips<a1.jaws){put.score+=0.7;put.reasons.push("1m Alligator expanding");}
  }

  if(et1.ema9>et1.ema21&&et1.slope9>0){
    call.score+=2;call.major++;call.reasons.push("1m EMA trend bullish");
    if(et1.slope21>=0)call.score+=0.5;
  }
  if(et1.ema9<et1.ema21&&et1.slope9<0){
    put.score+=2;put.major++;put.reasons.push("1m EMA trend bearish");
    if(et1.slope21<=0)put.score+=0.5;
  }

  if(m1.macd>m1.signal&&m1.hist>0){
    call.score+=2;call.major++;call.reasons.push("1m MACD bullish");
    if(m1.rising)call.score+=0.5;
  }
  if(m1.macd<m1.signal&&m1.hist<0){
    put.score+=2;put.major++;put.reasons.push("1m MACD bearish");
    if(m1.falling)put.score+=0.5;
  }

  if(ar1.up>ar1.down+20){call.score+=1.5;call.major++;call.reasons.push("1m Aroon up dominant");}
  if(ar1.down>ar1.up+20){put.score+=1.5;put.major++;put.reasons.push("1m Aroon down dominant");}

  if(last1&&prev1){
    const net=Number(last1.c)-Number(prev1.c);
    if(net>0){call.score+=0.6;call.reasons.push("closed 1m momentum up");}
    if(net<0){put.score+=0.6;put.reasons.push("closed 1m momentum down");}
  }

  if(fr1.ready&&Number.isFinite(last)){
    if(fr1.lastHigh&&last>fr1.lastHigh.price){call.score+=0.8;call.reasons.push("above confirmed 1m fractal high");}
    else if(fr1.lastLow&&last<fr1.lastLow.price){put.score+=0.8;put.reasons.push("below confirmed 1m fractal low");}
  }

  const direction=call.score>put.score?"CALL":"PUT";
  const win=direction==="CALL"?call:put, lose=direction==="CALL"?put:call;
  const edge=win.score-lose.score;
  if(win.score<7 || win.major<3 || edge<2.5){
    return {ok:false,reason:`1m direction not selective enough (score ${win.score.toFixed(1)}, edge ${edge.toFixed(1)}, major ${win.major})`,
      coreDirection:direction,callScore:call.score,putScore:put.score,bars15:bars15.length,bars5:bars5.length};
  }

  const m15=macdSnapshot(bars15,3,8,3), ar15=aroonSnapshot(bars15,7), m5=macdSnapshot(bars5,3,8,3), imp=tickImpulse(ticks);
  const bullish=direction==="CALL";
  let microConfirm=0,microScore=0,hardOpposition=false;
  const microReasons=[];

  if(m15.ready){
    const aligned=bullish?(m15.macd>m15.signal&&m15.hist>0):(m15.macd<m15.signal&&m15.hist<0);
    const opposed=bullish?(m15.macd<m15.signal&&m15.hist<0):(m15.macd>m15.signal&&m15.hist>0);
    if(aligned){microConfirm++;microScore+=1.5;microReasons.push("15s MACD aligned");}
    if(opposed&&Math.abs(m15.hist)>Math.abs(m15.prevHist||0))hardOpposition=true;
  }
  if(ar15.ready){
    const aligned=bullish?(ar15.up>ar15.down+15):(ar15.down>ar15.up+15);
    if(aligned){microConfirm++;microScore+=1;microReasons.push("15s Aroon aligned");}
  }
  const b15=bars15.at(-1);
  if(b15){
    const d=Number(b15.c)-Number(b15.o);
    if((bullish&&d>0)||(!bullish&&d<0)){microConfirm++;microScore+=0.7;microReasons.push("15s candle aligned");}
  }
  if(m5.ready){
    const aligned=bullish?(m5.macd>m5.signal&&m5.hist>0):(m5.macd<m5.signal&&m5.hist<0);
    if(aligned){microConfirm++;microScore+=1;microReasons.push("5s MACD aligned");}
  }
  if(imp.ready){
    const aligned=bullish?(imp.upRatio>=0.58&&imp.norm>0):(imp.downRatio>=0.58&&imp.norm<0);
    const strongOpp=bullish?(imp.downRatio>=0.68&&imp.norm<0):(imp.upRatio>=0.68&&imp.norm>0);
    if(aligned){microConfirm++;microScore+=1.5;microReasons.push("live tick impulse aligned");}
    if(strongOpp)hardOpposition=true;
  }

  if(hardOpposition){
    return {ok:false,reason:"micro-entry momentum is actively opposing the 1m direction",
      coreDirection:direction,callScore:call.score,putScore:put.score,bars15:bars15.length,bars5:bars5.length};
  }
  if(microConfirm<2||microScore<2){
    return {ok:false,reason:`waiting for lower-timeframe entry confirmation (${microConfirm} confirmations)`,
      coreDirection:direction,callScore:call.score,putScore:put.score,bars15:bars15.length,bars5:bars5.length};
  }

  const quality=clamp(0.55+Math.min(win.score,10)/10*0.20+Math.min(microScore,5)/5*0.10+Math.min(edge,4)*0.015,0.55,0.92);
  return {ok:true,direction,expirySeconds:EXPIRY_SECONDS,quality,callScore:call.score,putScore:put.score,edge,
    coreMajor:win.major,microConfirmations:microConfirm,microScore,reasons:[...win.reasons,...microReasons],
    bars5:bars5.length,bars15:bars15.length,bars1m:bars1m.length,lastPrice:last};
}

export class TickHub extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx; this.env=env; this.ws=null; this.ticks=new Map(); this.symbols=new Set();
    this.lastStatus="starting"; this.lastSubscribeStatus=null; this.connecting=false; this.provider="tiingo";
    this.lastWsMessageAt=0; this.lastPriceReceivedAt=0; this.lastConnectAt=0; this.reconnectCount=0; this.oneMinuteCache=new Map(); this.pendingSignals=[]; this.signalStats={total:0,wins:0,losses:0,draws:0,voids:0}; this.signalHistory=[];

    this.ctx.blockConcurrencyWhile(async()=>{
      // V11.2: prefer the configured warm list over old persisted symbols so a Basic/trial
      // account does not keep resubscribing to unsupported pairs from earlier builds.
      const configured=String(env.WS_SYMBOLS||DEFAULT_SYMBOLS).split(",").map(normalizeSymbol).filter(Boolean);
      for(const s of (configured.length?configured:[...DEFAULT_SYMBOLS.split(",")])) if(s) this.symbols.add(s);
      await this.ctx.storage.put("symbols",[...this.symbols]);
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
          `RESULT — ${sig.symbol}\n${sig.direction==="CALL"?"⬆️ CALL":"⬇️ PUT"} • 1 minute\n⚪ VOID — no fresh Tiingo tick was available at expiry`
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
        `RESULT — ${sig.symbol}\n${sig.direction==="CALL"?"⬆️ CALL":"⬇️ PUT"} • 1 minute\nENTRY: ${formatFxPrice(sig.symbol,entry)}\nEXIT: ${formatFxPrice(sig.symbol,exit)}\n${mark} ${result}\nTRACKING: Tiingo feed`
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

  async fetchOneMinuteBars(symbol){
    const cached=this.oneMinuteCache.get(symbol);
    if(cached&&Date.now()-cached.at<20000&&Array.isArray(cached.bars)&&cached.bars.length>=24)return cached.bars;

    const key=String(this.env.TIINGO_API_TOKEN||"").trim();
    if(!key)throw new Error("missing TIINGO_API_TOKEN");

    const ticker=toTiingoSymbol(symbol);
    if(!ticker)throw new Error("invalid Tiingo FX ticker");

    // Ask for recent intraday history and retain only the latest completed bars.
    const start=new Date(Date.now()-24*60*60*1000).toISOString().slice(0,10);
    const u=new URL(`https://api.tiingo.com/tiingo/fx/${ticker}/prices`);
    u.searchParams.set("startDate",start);
    u.searchParams.set("resampleFreq","1min");

    const res=await fetch(u.toString(),{
      headers:{
        accept:"application/json",
        authorization:`Token ${key}`
      }
    });
    const data=await res.json();
    if(!res.ok||!Array.isArray(data)){
      throw new Error(data?.detail||data?.message||`Tiingo 1m context request failed (${res.status})`);
    }

    const currentMinute=Math.floor(Date.now()/60000)*60000;
    const bars=data.map(v=>({
      t:Date.parse(String(v.date||"")),
      o:Number(v.open),h:Number(v.high),l:Number(v.low),c:Number(v.close),n:1
    })).filter(b=>Number.isFinite(b.t)&&[b.o,b.h,b.l,b.c].every(Number.isFinite)&&b.t<currentMinute)
      .sort((a,b)=>a.t-b.t)
      .slice(-80);

    if(bars.length<24)throw new Error(`only ${bars.length} completed Tiingo 1m bars available`);
    this.oneMinuteCache.set(symbol,{at:Date.now(),bars});
    return bars;
  }

  async analyze(symbol){
    symbol=normalizeSymbol(symbol); if(!symbol)return {ok:false,error:"invalid symbol"};
    await this.subscribe(symbol); await this.ensureSocket(); await this.refreshIfStale(symbol);

    let arr=this.ticks.get(symbol)||[];
    if(arr.length<24){await sleep(1500);arr=this.ticks.get(symbol)||[];}

    const receiveAge=arr.length?this.latestReceivedAge(symbol):Infinity;
    const marketAge=arr.length?this.latestMarketAge(symbol):Infinity;
    const bars15=buildBars(arr,15).length;

    if(arr.length<40||bars15<6){
      return {ok:false,warming:true,symbol,ticks:arr.length,bars15,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,reason:"live micro-feed warming; wait for at least 40 ticks and 6 x 15s bars"};
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
      return {ok:false,symbol,ticks:arr.length,bars15,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,reason:`1m context unavailable: ${String(e?.message||e)}`};
    }

    const x=score60s(arr,bars1m);
    if(!x.ok)return {...x,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,status:this.lastStatus};
    return {...x,symbol,ticks:arr.length,receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
      status:this.lastStatus,reconnectCount:this.reconnectCount,generatedAt:Date.now()};
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
      expiresAt:entryAt+EXPIRY_SECONDS*1000
    };
    this.pendingSignals.push(sig);
    await this.ctx.storage.put("pendingSignals",this.pendingSignals);
    await this.scheduleAlarm();
    return {ok:true,id:sig.id,expiresAt:sig.expiresAt};
  }

  async getTrackingStats(){
    const resolved=(this.signalStats.wins||0)+(this.signalStats.losses||0);
    const winRate=resolved>0?(this.signalStats.wins/resolved)*100:null;
    return {
      ok:true,
      ...this.signalStats,
      pending:this.pendingSignals.length,
      winRate,
      recent:this.signalHistory.slice(0,5)
    };
  }

  async fetch(req){
    const u=new URL(req.url), symbol=normalizeSymbol(u.searchParams.get("symbol")||"");

    if(u.pathname==="/reconnect"){
      await this.forceReconnect("requested");
      return json({ok:true,version:VERSION,status:this.lastStatus,reconnectCount:this.reconnectCount});
    }

    if(u.pathname==="/signal")return json(await this.analyze(symbol));
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
  if(replyMarkup) body.reply_markup=replyMarkup;
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body)
  });
  if(!r.ok)throw new Error(`Telegram ${r.status}: ${await r.text()}`);
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
  const checked=await Promise.all(FIXED_UNIVERSE.map(async symbol=>{
    try{
      const r=await hub(env,`/signal?symbol=${encodeURIComponent(symbol)}`);
      return {...r,symbol};
    }catch(e){
      return {ok:false,symbol,reason:String(e?.message||e)};
    }
  }));

  const qualified=checked.filter(x=>x?.ok&&x?.direction&&Number.isFinite(Number(x.quality)));
  qualified.sort((a,b)=>
    Number(b.quality||0)-Number(a.quality||0) ||
    Number(b.edge||0)-Number(a.edge||0) ||
    Number(b.microConfirmations||0)-Number(a.microConfirmations||0)
  );

  if(!qualified.length){
    return {ok:false,checked,reason:"No qualified 1-minute entry across the fixed six-pair universe."};
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
    if(request.method!=="POST")return new Response("V11.5 Tiingo auto-track six-pair scanner",{status:200});
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
        "V11.5 — use /signal to scan all 6 FX pairs and return only the strongest qualified 1-minute setup. Results are automatically tracked for 60 seconds. Use /stats for tracked performance and /checkall for feed health."
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
        `EXPIRY: 60s\n`+
        `STATUS: ${st.status||"n/a"}\n`+
        `SUBSCRIBE: ${st.subscribeStatus?.response?.message||st.subscribeStatus?.status||"n/a"}`
      );
      return new Response("ok");
    }
    const isUniverseScan=/^\/signal\s*$/i.test(text);
    if(isUniverseScan){
      const scan=await scanSixPairUniverse(env);
      if(!scan.ok){
        const summary=(scan.checked||[]).map(x=>`${x.symbol}: ${x.ok?"qualified":(x.reason||"not ready")}`).join("\n");
        await tgSend(env,chatId,`⏳ SIX-PAIR SCAN: WAIT\n${scan.reason}\n\n${summary}`);
        return new Response("ok");
      }

      const result=scan.best, symbol=result.symbol;
      const arrow=result.direction==="CALL"?"⬆️":"⬇️";
      const compact=String(env.BOT_COMPACT_MODE??"1")!=="0";

      if(compact){
        await tgSend(env,chatId,`${arrow} ${symbol}\nEXPIRY: 1 minute\nTRACKING: ON`);
      }else{
        await tgSend(env,chatId,`${arrow} ${symbol}\nEXPIRY: 1 minute\nSETUP QUALITY: ${(Number(result.quality)*100).toFixed(1)}%\nCALL SCORE: ${Number(result.callScore).toFixed(1)}\nPUT SCORE: ${Number(result.putScore).toFixed(1)}\nMICRO CONFIRMATIONS: ${result.microConfirmations}\nTRACKING: ON`);
      }

      await hubPost(env,"/track",{
        sourceUpdateId:update.update_id,
        chatId,
        symbol,
        direction:result.direction,
        entryPrice:result.lastPrice,
        entryAt:result.generatedAt||Date.now()
      });
      return new Response("ok");
    }

    if(/^\/signal\b/i.test(text)){
      await tgSend(env,chatId,"Use /signal by itself. The bot now scans all 6 pairs automatically and returns the strongest qualified setup.");
      return new Response("ok");
    }

    return new Response("ok");
  }
};
