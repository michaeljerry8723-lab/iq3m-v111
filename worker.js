// V11.1 — 15-second tick sniper with Cloudflare Durable Object
import { DurableObject } from "cloudflare:workers";

const VERSION = "11.2.0-15s-tick-sniper-auto-reconnect";
const DEFAULT_SYMBOLS = "EUR/USD";

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function clamp(x,a,b){ return Math.max(a,Math.min(b,Number(x)||0)); }
function mean(xs){ return xs.length ? xs.reduce((a,b)=>a+Number(b),0)/xs.length : NaN; }
function normalizeSymbol(input){
  let s=String(input||"").trim().toUpperCase().replace(/\s+/g,"");
  s=s.replace(/[-_]/g,"/");
  if(/^[A-Z]{6}$/.test(s)) s=s.slice(0,3)+"/"+s.slice(3);
  return /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(s) ? s : null;
}
function tsMs(t){ const n=Number(t); if(!Number.isFinite(n)) return Date.now(); return n<1e12?n*1000:n; }
function json(data,status=200){ return new Response(JSON.stringify(data,null,2),{status,headers:{"content-type":"application/json;charset=UTF-8"}}); }

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

function score15s(ticks){
  const bars5=buildBars(ticks,5), bars15=buildBars(ticks,15);
  const a=alligatorSnapshot(bars15), m=macdSnapshot(bars5,3,8,3), ar=aroonSnapshot(bars5,7), fr=fractalSnapshot(bars5), imp=tickImpulse(ticks);
  const last=Number(ticks.at(-1)?.p), call={score:0,reasons:[]}, put={score:0,reasons:[]};
  if(a.ready){
    if(a.lips>a.teeth&&a.teeth>a.jaws&&a.lipsSlope>0&&a.teethSlope>=0){call.score+=3;call.reasons.push("15s Alligator bullish");}
    if(a.lips<a.teeth&&a.teeth<a.jaws&&a.lipsSlope<0&&a.teethSlope<=0){put.score+=3;put.reasons.push("15s Alligator bearish");}
    if(a.gap>a.prevGap){ if(a.lips>a.jaws){call.score+=1;call.reasons.push("Alligator expanding");} else {put.score+=1;put.reasons.push("Alligator expanding");} }
  }
  if(m.ready){
    if(m.macd>m.signal&&m.hist>0){call.score+=2;call.reasons.push("5s MACD bullish");}
    if(m.macd<m.signal&&m.hist<0){put.score+=2;put.reasons.push("5s MACD bearish");}
    if(m.rising){call.score+=1;call.reasons.push("MACD accelerating");}
    if(m.falling){put.score+=1;put.reasons.push("MACD accelerating");}
  }
  if(ar.ready){
    if(ar.up>ar.down+15){call.score+=2;call.reasons.push("Aroon up dominant");}
    if(ar.down>ar.up+15){put.score+=2;put.reasons.push("Aroon down dominant");}
  }
  if(fr.ready&&Number.isFinite(last)){
    if(fr.lastHigh&&last>fr.lastHigh.price){call.score+=1.5;call.reasons.push("fractal breakout");}
    else if(fr.lastLow&&last<fr.lastLow.price){put.score+=1.5;put.reasons.push("fractal breakout");}
    else if(fr.lastLow&&Math.abs(last-fr.lastLow.price)<Math.abs(last-(fr.lastHigh?.price??Infinity))){call.score+=0.5;call.reasons.push("near support fractal");}
    else if(fr.lastHigh){put.score+=0.5;put.reasons.push("near resistance fractal");}
  }
  if(imp.ready){
    if(imp.upRatio>=0.60&&imp.norm>0){call.score+=2;call.reasons.push("tick impulse up");}
    if(imp.downRatio>=0.60&&imp.norm<0){put.score+=2;put.reasons.push("tick impulse down");}
  }
  const winner=call.score>=put.score?"CALL":"PUT", ws=Math.max(call.score,put.score), ls=Math.min(call.score,put.score), margin=ws-ls;
  // Relative setup-strength score, deliberately not a claimed probability.
  const quality=clamp(0.54 + ws*0.025 + margin*0.018,0.54,0.93);
  return {direction:winner,quality,callScore:call.score,putScore:put.score,margin,callReasons:call.reasons,putReasons:put.reasons,bars5:bars5.length,bars15:bars15.length,lastPrice:last};
}

export class TickHub extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx; this.env=env; this.ws=null; this.ticks=new Map(); this.symbols=new Set();
    this.lastStatus="starting"; this.lastSubscribeStatus=null; this.connecting=false;
    this.lastWsMessageAt=0; this.lastPriceReceivedAt=0; this.lastConnectAt=0; this.reconnectCount=0;

    this.ctx.blockConcurrencyWhile(async()=>{
      // V11.2: prefer the configured warm list over old persisted symbols so a Basic/trial
      // account does not keep resubscribing to unsupported pairs from earlier builds.
      const configured=String(env.WS_SYMBOLS||DEFAULT_SYMBOLS).split(",").map(normalizeSymbol).filter(Boolean);
      for(const s of (configured.length?configured:[...DEFAULT_SYMBOLS.split(",")])) if(s) this.symbols.add(s);
      await this.ctx.storage.put("symbols",[...this.symbols]);
      await this.ensureSocket();
      await this.ctx.storage.setAlarm(Date.now()+10000);
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

  async alarm(){
    try{
      await this.ensureSocket();

      if(this.ws&&this.ws.readyState===1){
        this.ws.send(JSON.stringify({action:"heartbeat"}));

        // If we have had no inbound WebSocket traffic for 25 seconds, rebuild the socket.
        const msgAge=this.lastWsMessageAt?((Date.now()-this.lastWsMessageAt)/1000):Infinity;
        if(msgAge>25) await this.forceReconnect("no websocket messages for >25s");
      } else {
        await this.forceReconnect("socket not open");
      }
    }catch(e){
      this.lastStatus=`alarm error: ${String(e?.message||e)}`;
    }
    await this.ctx.storage.setAlarm(Date.now()+10000);
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

    const key=String(this.env.TWELVE_DATA_WS_API_KEY||"").trim();
    if(!key){this.lastStatus="missing TWELVE_DATA_WS_API_KEY";return;}

    this.connecting=true;
    try{
      const ws=new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(key)}`);
      this.ws=ws;

      ws.addEventListener("open",()=>{
        this.connecting=false;
        this.lastConnectAt=Date.now();
        this.lastWsMessageAt=Date.now();
        this.lastStatus="connected";
        if(this.symbols.size){
          ws.send(JSON.stringify({
            action:"subscribe",
            params:{symbols:[...this.symbols].join(",")}
          }));
        }
      });

      ws.addEventListener("message",ev=>this.onMessage(ev));

      ws.addEventListener("close",()=>{
        if(this.ws===ws) this.ws=null;
        this.connecting=false;
        this.lastStatus="closed";
      });

      ws.addEventListener("error",()=>{
        this.lastStatus="websocket error";
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

      if(x.event==="subscribe-status"){
        this.lastSubscribeStatus=x;
        this.lastStatus=x.status||"subscribe-status";
        return;
      }

      if(x.event==="heartbeat"){
        if(this.lastStatus==="closed"||this.lastStatus==="reconnecting") this.lastStatus="connected";
        return;
      }

      if(x.event!=="price")return;

      const s=normalizeSymbol(x.symbol), p=Number(x.price), t=tsMs(x.timestamp), r=Date.now();
      if(!s||!Number.isFinite(p))return;

      this.lastPriceReceivedAt=r;
      const arr=this.ticks.get(s)||[];
      arr.push({t,p,r});

      const cutoff=Date.now()-5*60*1000;
      while(arr.length&&Number(arr[0].r||arr[0].t)<cutoff)arr.shift();
      if(arr.length>5000)arr.splice(0,arr.length-5000);
      this.ticks.set(s,arr);
    }catch(_){}
  }

  async subscribe(symbol){
    symbol=normalizeSymbol(symbol); if(!symbol)return false;
    if(!this.symbols.has(symbol)){
      this.symbols.add(symbol);
      await this.ctx.storage.put("symbols",[...this.symbols]);
      await this.ensureSocket();
      if(this.ws&&this.ws.readyState===1){
        this.ws.send(JSON.stringify({action:"subscribe",params:{symbols:symbol}}));
      }
    }
    return true;
  }

  async refreshIfStale(symbol){
    const receiveAge=this.latestReceivedAge(symbol);
    const msgAge=this.lastWsMessageAt?Math.max(0,(Date.now()-this.lastWsMessageAt)/1000):Infinity;

    if(receiveAge>15 || msgAge>25 || !(this.ws&&this.ws.readyState===1)){
      await this.forceReconnect(`stale ${symbol} feed`);
      await sleep(1800);
    }
  }

  async analyze(symbol){
    symbol=normalizeSymbol(symbol); if(!symbol)return {ok:false,error:"invalid symbol"};

    await this.subscribe(symbol);
    await this.ensureSocket();
    await this.refreshIfStale(symbol);

    let arr=this.ticks.get(symbol)||[];
    if(arr.length<16){
      await sleep(1500);
      arr=this.ticks.get(symbol)||[];
    }

    const receiveAge=arr.length?this.latestReceivedAge(symbol):Infinity;
    const marketAge=arr.length?this.latestMarketAge(symbol):Infinity;
    const bars15=buildBars(arr,15).length;

    if(arr.length<40 || bars15<5){
      return {
        ok:false,warming:true,symbol,ticks:arr.length,bars15,
        receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,
        subscribeStatus:this.lastSubscribeStatus?.status||null,
        reason:"micro-feed warming; wait for at least 40 ticks and 5 completed 15s bars"
      };
    }

    // Never manufacture a 15-second signal from a feed that is not currently updating.
    if(receiveAge>8){
      return {
        ok:false,symbol,ticks:arr.length,bars15,
        receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,
        subscribeStatus:this.lastSubscribeStatus?.status||null,
        reason:`live feed stale: no received tick for ${receiveAge.toFixed(1)}s`
      };
    }

    // Also block a materially delayed provider timestamp. This prevents "freshly received"
    // but old/delayed quotes from being treated as a true 15-second entry feed.
    if(marketAge>20){
      return {
        ok:false,symbol,ticks:arr.length,bars15,
        receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
        status:this.lastStatus,
        subscribeStatus:this.lastSubscribeStatus?.status||null,
        reason:`provider timestamp is ${marketAge.toFixed(1)}s behind live time`
      };
    }

    const s=score15s(arr);
    return {
      ok:true,symbol,expirySeconds:15,...s,ticks:arr.length,
      receiveAgeSeconds:receiveAge,marketAgeSeconds:marketAge,
      status:this.lastStatus,reconnectCount:this.reconnectCount,
      generatedAt:Date.now()
    };
  }

  async fetch(req){
    const u=new URL(req.url), symbol=normalizeSymbol(u.searchParams.get("symbol")||"");

    if(u.pathname==="/reconnect"){
      await this.forceReconnect("requested");
      return json({ok:true,version:VERSION,status:this.lastStatus,reconnectCount:this.reconnectCount});
    }

    if(u.pathname==="/signal")return json(await this.analyze(symbol));

    if(u.pathname==="/status"){
      if(symbol) await this.subscribe(symbol);

      // Status calls also heal a stale socket, but do not wait long enough to hide the diagnosis.
      if(symbol && this.latestReceivedAge(symbol)>20) {
        try{ await this.forceReconnect(`status detected stale ${symbol}`); }catch(_){}
      } else {
        await this.ensureSocket();
      }

      const arr=symbol?(this.ticks.get(symbol)||[]):[];
      const lastMessageAge=this.lastWsMessageAt?Math.max(0,(Date.now()-this.lastWsMessageAt)/1000):null;

      return json({
        version:VERSION,
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
        reconnectCount:this.reconnectCount
      });
    }

    return json({ok:true,version:VERSION});
  }
}

async function tgSend(env,chatId,text){
  const token=String(env.TELEGRAM_BOT_TOKEN||"").trim();
  if(!token)throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
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

export default {
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(u.pathname==="/health")return json({ok:true,version:VERSION});
    if(u.pathname==="/feed"){
      const s=normalizeSymbol(u.searchParams.get("symbol")||"EUR/JPY")||"EUR/JPY";
      return json(await hub(env,`/status?symbol=${encodeURIComponent(s)}`));
    }
    if(request.method!=="POST")return new Response("V11.2 15s tick sniper",{status:200});
    if(u.pathname!=="/telegram")return new Response("Not found",{status:404});
    const secret=String(env.TELEGRAM_WEBHOOK_SECRET||"").trim();
    if(secret&&request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==secret)return new Response("forbidden",{status:403});
    const update=await request.json(); const msg=update.message||update.edited_message; if(!msg?.chat?.id)return new Response("ok");
    const chatId=msg.chat.id, text=String(msg.text||"").trim();
    if(/^\/version$/i.test(text)){await tgSend(env,chatId,VERSION);return new Response("ok");}
    if(/^\/start$/i.test(text)){await tgSend(env,chatId,"V11.2 live-tick engine. On a Twelve Data Basic/trial key, test EUR/USD first. Use /feed EUR/USD, /signal EUR/USD, or /reconnect.");return new Response("ok");}
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
        `CONNECTED: ${st.connected?"YES":"NO"}\n`+
        `TICKS: ${st.ticks||0}\n`+
        `5s BARS: ${st.bars5||0}\n`+
        `15s BARS: ${st.bars15||0}\n`+
        `RECEIVED TICK AGE: ${st.lastTickAgeSeconds??"n/a"}s\n`+
        `PROVIDER TICK AGE: ${st.providerTickAgeSeconds??"n/a"}s\n`+
        `WS MESSAGE AGE: ${st.lastWsMessageAgeSeconds??"n/a"}s\n`+
        `RECONNECTS: ${st.reconnectCount||0}\n`+
        `STATUS: ${st.status||"n/a"}\n`+
        `SUBSCRIBE: ${st.subscribeStatus?.status||st.subscribeStatus||"n/a"}`
      );
      return new Response("ok");
    }
    const symbol=parseSignalText(text);
    if(!symbol)return new Response("ok");
    const result=await hub(env,`/signal?symbol=${encodeURIComponent(symbol)}`);
    if(!result.ok){
      await tgSend(env,chatId,
        `⏳ ${symbol} NOT READY\n`+
        `${result.reason||"Waiting for live ticks"}\n`+
        `Ticks: ${result.ticks||0} • 15s bars: ${result.bars15||0}\n`+
        `Received age: ${Number.isFinite(Number(result.receiveAgeSeconds))?Number(result.receiveAgeSeconds).toFixed(1):"n/a"}s • `+
        `Provider age: ${Number.isFinite(Number(result.marketAgeSeconds))?Number(result.marketAgeSeconds).toFixed(1):"n/a"}s\n`+
        `Status: ${result.status||"n/a"}`
      );
      return new Response("ok");
    }
    const arrow=result.direction==="CALL"?"⬆️":"⬇️";
    const compact=String(env.BOT_COMPACT_MODE??"1")!=="0";
    if(compact) await tgSend(env,chatId,arrow);
    else await tgSend(env,chatId,`${arrow} ${symbol}\nEXPIRY: 15 seconds\nSETUP QUALITY: ${(Number(result.quality)*100).toFixed(1)}%\nCALL SCORE: ${Number(result.callScore).toFixed(1)}\nPUT SCORE: ${Number(result.putScore).toFixed(1)}`);
    return new Response("ok");
  }
};
