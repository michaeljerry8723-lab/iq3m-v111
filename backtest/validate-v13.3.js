#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT=path.dirname(fileURLToPath(import.meta.url)), RESULTS=path.join(ROOT,"results");
const CANDIDATE={dmiGapMin:20.930996673679135,adxMax:76.22584098021053};
const pct=x=>x==null?"n/a":(100*x).toFixed(2)+"%";
function parseCsv(s){const rows=[];let row=[],cell="",q=false;for(let i=0;i<s.length;i++){const c=s[i],n=s[i+1];if(q&&c=='"'&&n=='"'){cell+='"';i++;continue;}if(c=='"'){q=!q;continue;}if(!q&&c==","){row.push(cell);cell="";continue;}if(!q&&(c==="\n"||c==="\r")){if(c==="\r"&&n==="\n")i++;row.push(cell);cell="";if(row.some(x=>x!==""))rows.push(row);row=[];continue;}cell+=c;}if(cell||row.length){row.push(cell);rows.push(row);}const h=rows.shift()||[];return rows.map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??""])));}
const outcome=rows=>{const wl=rows.filter(r=>["WIN","LOSS"].includes(r.result)),w=wl.filter(r=>r.result==="WIN").length;return {signals:rows.length,wl:wl.length,wins:w,losses:wl.length-w,draws:rows.filter(r=>r.result==="DRAW").length,winRate:wl.length?w/wl.length:null};};
const passes=r=>Number(r.dmiGap)>=CANDIDATE.dmiGapMin&&Number(r.adx)<=CANDIDATE.adxMax;
function addMonths(ym,n){const [y,m]=ym.split("-").map(Number),d=new Date(Date.UTC(y,m-1+n,1));return d.toISOString().slice(0,7);}
async function main(){
 const rows=parseCsv(await fs.readFile(path.join(RESULTS,"signals.csv"),"utf8"));
 const base=JSON.parse(await fs.readFile(path.join(RESULTS,"results.json"),"utf8"));
 const months=[...new Set(rows.map(r=>r.month))].sort(), filtered=rows.filter(passes);
 const monthly=months.map(month=>({month,baseline:outcome(rows.filter(r=>r.month===month)),candidate:outcome(filtered.filter(r=>r.month===month))}));
 const rolling=[];
 for(let i=2;i<months.length;i++){const train=months.slice(Math.max(0,i-2),i),test=months[i],testRows=rows.filter(r=>r.month===test),cand=testRows.filter(passes);rolling.push({trainMonths:train,testMonth:test,baseline:outcome(testRows),candidate:outcome(cand)});}
 const stable=rolling.filter(x=>x.candidate.wl>=10),positive=stable.filter(x=>x.candidate.winRate>x.baseline.winRate).length;
 const overall={baseline:outcome(rows),candidate:outcome(filtered)};
 const out={generatedAt:new Date().toISOString(),name:"V13.3 predeclared rolling validation",provider:base.provider,candidate:CANDIDATE,method:"Thresholds are frozen from V13.2 before this report. No threshold search or retuning is performed here.",overall,monthly,rolling,summary:{eligibleRollingWindows:stable.length,windowsBeatingBaseline:positive,allEligibleWindowsBeatBaseline:stable.length>0&&positive===stable.length}};
 await fs.writeFile(path.join(RESULTS,"v13.3-validation.json"),JSON.stringify(out,null,2)+"\n");
 const lines=["# V13.3 Predeclared Rolling Validation","",`Frozen rule: **DMI gap >= ${CANDIDATE.dmiGapMin.toFixed(2)} AND ADX <= ${CANDIDATE.adxMax.toFixed(2)}**`,"","No threshold search is performed in this stage. The purpose is to test whether the V13.2 candidate remains stable across chronological windows.","",`Overall baseline: ${overall.baseline.wins}W/${overall.baseline.losses}L — ${pct(overall.baseline.winRate)}`,`Frozen candidate: ${overall.candidate.wins}W/${overall.candidate.losses}L — ${pct(overall.candidate.winRate)}`,"","## Rolling test windows",""];
 for(const x of rolling)lines.push(`- ${x.testMonth}: baseline ${x.baseline.wins}W/${x.baseline.losses}L (${pct(x.baseline.winRate)}); candidate ${x.candidate.wins}W/${x.candidate.losses}L (${pct(x.candidate.winRate)}), W/L n=${x.candidate.wl}.`);
 lines.push("","## Decision guardrail","",`Eligible windows (candidate W/L n >= 10): ${stable.length}; windows beating their baseline: ${positive}.`,"","This report does not promote the rule to production. A genuinely new future period is still needed because the frozen thresholds originated from this six-month history. Mode A also lacks genuine 30-second/tick/spread and Pocket Option settlement data.");
 await fs.writeFile(path.join(ROOT,"V13_3_VALIDATION.md"),lines.join("\n")+"\n");
 console.log(JSON.stringify({candidate:CANDIDATE,overall,rollingSummary:out.summary},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=2;});
