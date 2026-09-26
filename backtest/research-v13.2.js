#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RESULTS=path.join(ROOT,"results");
const pct=x=>x==null?"n/a":(100*x).toFixed(2)+"%";
function parseCsv(s){
  const rows=[];let row=[],cell="",q=false;
  for(let i=0;i<s.length;i++){const c=s[i],n=s[i+1];
    if(q&&c=='"'&&n=='"'){cell+='"';i++;continue;}
    if(c=='"'){q=!q;continue;}
    if(!q&&c==","){row.push(cell);cell="";continue;}
    if(!q&&(c==="\n"||c==="\r")){if(c==="\r"&&n==="\n")i++;row.push(cell);cell="";if(row.some(x=>x!==""))rows.push(row);row=[];continue;}
    cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}
  const h=rows.shift()||[];return rows.map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??""])));
}
const num=(r,k)=>{const v=Number(r[k]);return Number.isFinite(v)?v:null;};
const outcome=rows=>{const wl=rows.filter(r=>r.result==="WIN"||r.result==="LOSS"),w=wl.filter(r=>r.result==="WIN").length;return {n:rows.length,wl:wl.length,wins:w,losses:wl.length-w,wr:wl.length?w/wl.length:null};};
const median=a=>{const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;return x[Math.floor(x.length/2)];};
function rule(row,r){
  if(r.field==="hourUtc"){const h=new Date(Number(row.entryAt)).getUTCHours();return r.values.includes(h);}
  if(r.field==="symbol")return r.values.includes(row.symbol);
  const v=num(row,r.field);if(v==null)return false;
  if(r.op===">=")return v>=r.value;if(r.op==="<=")return v<=r.value;if(r.op==="between")return v>=r.lo&&v<=r.h;return false;
}
function metrics(rows,rules=[]){return outcome(rows.filter(x=>rules.every(r=>rule(x,r))));}
function qCandidates(dev,field){
  const vals=dev.map(r=>num(r,field)).filter(Number.isFinite).sort((a,b)=>a-b);if(vals.length<40)return[];
  const qs=[.2,.3,.4,.5,.6,.7,.8].map(q=>vals[Math.floor((vals.length-1)*q)]);
  return [...new Set(qs)].flatMap(v=>[{field,op:">=",value:v,label:`${field} >= ${v}`},{field,op:"<=",value:v,label:`${field} <= ${v}`}]);
}
function score(m,base){
  if(!m||m.wl<25||m.wr==null)return -Infinity;
  const lift=m.wr-base;return lift*Math.sqrt(m.wl);
}
async function main(){
  const rows=parseCsv(await fs.readFile(path.join(RESULTS,"signals.csv"),"utf8"));
  const report=JSON.parse(await fs.readFile(path.join(RESULTS,"results.json"),"utf8"));
  const devMonths=new Set(report.months.development),holdMonths=new Set(report.months.holdout);
  const dev=rows.filter(r=>devMonths.has(r.month)),hold=rows.filter(r=>holdMonths.has(r.month));
  const db=outcome(dev),hb=outcome(hold);
  const numeric=["dmiGap","adx","atrRatio","rsi","eff5","eff15","distFastAtr","roomAtr","quality","macdHist","aroonLead","pressure"];
  let candidates=numeric.flatMap(f=>qCandidates(dev,f));
  for(const s of [...new Set(dev.map(r=>r.symbol))])candidates.push({field:"symbol",values:[s],label:`symbol = ${s}`});
  for(let h=0;h<24;h++)candidates.push({field:"hourUtc",values:[h],label:`hour UTC = ${h}`});
  let singles=candidates.map(r=>({rules:[r],dev:metrics(dev,[r])})).filter(x=>x.dev.wl>=25).sort((a,b)=>score(b.dev,db.wr)-score(a.dev,db.wr));
  const top=singles.slice(0,24).map(x=>x.rules[0]),combos=[];
  for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
    if(top[i].field===top[j].field)continue;
    const rules=[top[i],top[j]],m=metrics(dev,rules);if(m.wl>=25)combos.push({rules,dev:m});
  }
  const selected=[...singles,...combos].sort((a,b)=>score(b.dev,db.wr)-score(a.dev,db.wr)).slice(0,40).map(x=>({...x,hold:metrics(hold,x.rules)}));
  const robust=selected.filter(x=>x.hold.wl>=20&&x.hold.wr!=null&&x.hold.wr>hb.wr&&x.dev.wr>db.wr).sort((a,b)=>(b.hold.wr-hb.wr)*Math.sqrt(b.hold.wl)-(a.hold.wr-hb.wr)*Math.sqrt(a.hold.wl));
  const out={generatedAt:new Date().toISOString(),strategy:"V13.2 research only",provider:report.provider,baseline:{development:db,holdout:hb},method:"Rules are ranked on development only. Holdout is inspected only after selection; no production thresholds are changed automatically.",topDevelopment:selected.slice(0,15),robustCandidates:robust.slice(0,12)};
  await fs.writeFile(path.join(RESULTS,"v13.2-research.json"),JSON.stringify(out,null,2)+"\n");
  const lines=["# V13.2 Walk-Forward Research","",`Development baseline: ${db.wins}W/${db.losses}L — ${pct(db.wr)}`,`Holdout baseline: ${hb.wins}W/${hb.losses}L — ${pct(hb.wr)}`,"","## Candidates that improved both samples",""];
  if(!robust.length)lines.push("No candidate passed the minimum sample and both-sample improvement checks.");
  else for(const x of robust.slice(0,12))lines.push(`- **${x.rules.map(r=>r.label).join(" AND ")}** — dev ${x.dev.wins}W/${x.dev.losses}L (${pct(x.dev.wr)}); holdout ${x.hold.wins}W/${x.hold.losses}L (${pct(x.hold.wr)}), holdout W/L n=${x.hold.wl}.`);
  lines.push("","## Guardrail","","This is a research screen, not a live strategy promotion. The holdout is not used to tune thresholds after viewing it. A new untouched period or rolling walk-forward run is required before any candidate can be promoted to production.","","Mode A still lacks genuine 30-second/tick/spread and Pocket Option settlement data.");
  await fs.writeFile(path.join(ROOT,"V13_2_RESEARCH.md"),lines.join("\n")+"\n");
  console.log(JSON.stringify({development:db,holdout:hb,robustCandidates:robust.length,top:robust[0]||null},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=2;});
