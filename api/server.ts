import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actors, actions, plays, towns } from './content.js';
import { SCHEMA_VERSION, TRANSITIONS, canTransition, migrateTours, validate, findReplay, type Tour, type Draft } from './domain.js';

const file = process.env.DATA_FILE || join(process.cwd(), 'data.json');
// 唯一的迁移入口：存档在加载时一次性同步升级，之后所有（含并发）请求
// 看到的都是同一份已迁移数据，不存在“某个请求读到半迁移存档”的窗口。
let tours:Tour[] = existsSync(file) ? migrateTours(JSON.parse(readFileSync(file,'utf8'))) : [];
let persistTimer:ReturnType<typeof setTimeout>|undefined;
const flush=()=>writeFileSync(file,JSON.stringify(tours,null,2));
const persist=()=>{if(persistTimer)clearTimeout(persistTimer);persistTimer=setTimeout(flush,120)};
const closePersist=()=>{if(persistTimer){clearTimeout(persistTimer);persistTimer=undefined;flush()}};

const app=express(); app.use(cors()); app.use(express.json({limit:'1mb'}));
const ok=(res:any,data:any)=>res.json(data);
const fail=(res:any,code:string,message:string,status=400)=>res.status(status).json({code,message});
const getTour=(req:Request,res:Response):Tour|null=>{const t=tours.find(x=>x.id===req.params.id);if(!t){fail(res,'TOUR_NOT_FOUND','存档不存在',404);return null}return t};
function town(t:Tour){return towns.find(x=>x.id===t.townIds[t.stopIndex])!}
function route(seed:number){let state=(seed>>>0)||1;const shuffled=[...towns];for(let i=shuffled.length-1;i>0;i--){state=(state*1664525+1013904223)>>>0;const j=state%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]}return shuffled.slice(0,6).map(x=>x.id)}

// 统一前置守卫：状态机 + 乐观并发修订号。并发请求必须针对同一个已迁移
// 存档的同一修订号操作；一旦其中一个请求推进了版本，迟到的请求直接 409，
// 不能再把状态改回去。
function guard(req:Request,res:Response,t:Tour,action:keyof typeof TRANSITIONS):boolean{
  if(!canTransition(t.status,action)){
    fail(res,'INVALID_TOUR_STATE','当前阶段不能执行该操作',409);return false;
  }
  const expected=req.header('If-Match') ?? String(req.body?.expectedVersion ?? '');
  if(expected && Number.isFinite(Number(expected)) && Number(expected)!==t.version){
    fail(res,'VERSION_CONFLICT','存档已被其他操作更新，请刷新后重试',409);return false;
  }
  return true;
}
const bump=(t:Tour)=>{t.version++};

app.get('/health/live',(_,res)=>ok(res,{ok:true,schemaVersion:SCHEMA_VERSION}));
app.get('/api/v1/content/bootstrap',(_,res)=>ok(res,{actors,actions,plays,towns}));
app.get('/api/v1/tours',(_,res)=>ok(res,{tours:tours.map(t=>({id:t.id,name:t.name,status:t.status,stopIndex:t.stopIndex,funds:t.funds,reputation:t.reputation,version:t.version,schemaVersion:t.schemaVersion}))}));
app.post('/api/v1/tours',(req,res)=>{
  const body=req.body??{};
  const name=String(body.name||'未命名剧团').trim().slice(0,24)||'未命名剧团';
  const seed=Number.isFinite(body.seed)?Number(body.seed):Math.floor(Math.random()*1000000);
  const t:Tour={id:randomUUID(),name,seed,status:'INVESTIGATING',townIds:route(seed),stopIndex:0,funds:420,reputation:50,inspiration:3,version:1,schemaVersion:SCHEMA_VERSION,actors:actors.slice(0,3).map(a=>({...a,level:1,xp:0,stamina:a.stamina,fatigue:0})),visited:[],clues:{},history:[],unlocked:[]};
  tours.push(t);persist();ok(res,{tour:t});
});
app.get('/api/v1/tours/:id',(req,res)=>{const t=getTour(req,res);if(!t||!('id'in t))return; ok(res,{tour:t,town:town(t),plays,actions,towns})});

app.post('/api/v1/tours/:id/travel',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  if(!guard(req,res,t,'travel'))return;
  const next=String(req.body?.townId||'');
  if(t.townIds[t.stopIndex+1]!==next)return fail(res,'INVALID_ROUTE','请选择相邻路线');
  const target=towns.find(x=>x.id===next)!;
  const need=Math.round(target.capacity/8);
  const cost=Math.max(12,need);
  if(t.funds<need)return fail(res,'INSUFFICIENT_RESOURCE','资金不足以抵达下一站',422);
  t.funds-=cost;t.stopIndex++;t.status='INVESTIGATING';bump(t);persist();ok(res,{tour:t,town:target,cost});
});

app.post('/api/v1/tours/:id/investigations',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  // 仅调查阶段可调查；准备、演出后、终局、已完成一律拒绝，状态无法被打回。
  if(!guard(req,res,t,'investigate'))return;
  const cur=town(t);
  const kind=String(req.body?.kind||'');
  if(!['market','tavern','shrine','rehearse'].includes(kind))return fail(res,'VALIDATION_ERROR','未知调查类型');
  t.clues[cur.id]=Array.from(new Set([...(t.clues[cur.id]||[]),...cur.clues.slice(0,kind==='rehearse'?0:kind==='market'?1:kind==='tavern'?2:3)]));
  t.status='PREPARING';bump(t);persist();ok(res,{tour:t,clues:t.clues[cur.id]});
});

app.get('/api/v1/tours/:id/production',(req,res)=>{const t=getTour(req,res);if(!t||!('id'in t))return;ok(res,{draft:t.draft||{playId:plays[0].id,assignments:Object.fromEntries(t.actors.map(a=>[a.id,'main'])),timeline:[],endings:[0,0,0]},plays,actions,actors:t.actors})});

app.post('/api/v1/tours/:id/production/validate',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  const d=req.body as Draft;const r=validate(t,d);
  ok(res,{valid:r.errors.length===0,errors:r.errors,preview:{funds:Math.max(0,t.funds-8),inspiration:Math.max(0,t.inspiration-(Array.isArray(d?.endings)&&d.endings.length===3?1:0))}});
});

app.put('/api/v1/tours/:id/production',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  // 只允许在编排阶段保存草稿；演出后/移动中/终局/已完成不能借此改档回退。
  if(!guard(req,res,t,'saveProduction'))return;
  const d=req.body as Draft;
  const r=validate(t,d);
  if(r.errors.length)return fail(res,'INVALID_PRODUCTION',r.errors.join('；'),422);
  t.draft=d;t.status='READY';bump(t);persist();ok(res,{tour:t});
});

app.post('/api/v1/tours/:id/performances',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  const key=String(req.header('Idempotency-Key')||'');
  // 幂等重放按存档隔离，且重放不受阶段守卫限制（同一请求的安全重试）。
  const previous=findReplay(t,key);
  if(previous){ok(res,{performance:previous,tour:t,replayed:true});return}
  if(!guard(req,res,t,'perform'))return;
  const submitted=req.body as Partial<Draft>|undefined;
  const d=submitted?.playId?submitted as Draft:t.draft!;
  const r=validate(t,d);
  if(r.errors.length)return fail(res,'INVALID_PRODUCTION',r.errors.join('；'),422);
  const p=r.p!,cur=town(t);
  const tagScore=d.timeline.reduce((s:number,e:any)=>s+(actions.find(a=>a.id===e.actionId)?.tags.some(x=>cur.mood.includes(x)||p.tags.includes(x))?5:1),0);
  const score=Math.max(0,Math.min(100,45+tagScore+Math.min(20,t.reputation/5)-d.timeline.length*1));
  const fill=Math.min(1,0.45+t.reputation/160+tagScore/250);
  const income=Math.round(cur.capacity*fill*cur.ticket/10);
  const feedback=score>=75?`${cur.audience}喜欢你对“${cur.legend}”的回应，散场后仍在讨论结尾。`:`观众希望动作更贴近${cur.mood}的气氛；有人记住了你的勇气。`;
  const perf={id:randomUUID(),idempotencyKey:key||undefined,townId:cur.id,score,income,feedback,ending:d.endings[2],snapshot:d,createdAt:new Date().toISOString()};
  t.history.push(perf);
  t.funds+=income;
  t.reputation=Math.max(0,Math.min(100,t.reputation+Math.round((score-55)/5)));
  t.inspiration=Math.max(0,t.inspiration+(score>72?1:0));
  for(const a of t.actors){
    a.xp+=Math.round(score/4);
    a.stamina=Math.max(10,a.stamina-12);
    a.fatigue=Math.min(3,a.fatigue+(score<50?1:0));
    if(a.xp>=a.level*100){a.level++;a.xp-=a.level*100}
  }
  t.visited.push(cur.id);
  t.status=t.stopIndex>=t.townIds.length-1?'FINALE_READY':'ROUTE_SELECTION';
  t.draft=undefined;bump(t);persist();
  ok(res,{performance:perf,tour:t});
});

app.post('/api/v1/tours/:id/rest',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  // 休息只在驻场编排/选路阶段开放；终局与已完成的存档不能被改动。
  if(!guard(req,res,t,'rest'))return;
  for(const a of t.actors)a.stamina=Math.min(100,a.stamina+25),a.fatigue=Math.max(0,a.fatigue-1);
  bump(t);persist();ok(res,{tour:t});
});

app.get('/api/v1/tours/:id/history',(req,res)=>{const t=getTour(req,res);if(!t||!('id'in t))return;ok(res,{history:t.history})});

app.post('/api/v1/tours/:id/finale',(req,res)=>{
  const t=getTour(req,res);if(!t||!('id'in t))return;
  if(!guard(req,res,t,'finale'))return;
  const avg=t.history.slice(1).reduce((n,x)=>n+x.score,0)/Math.max(1,t.history.length-1);
  t.status='COMPLETED';bump(t);persist();
  ok(res,{ending:avg>=75?'万镇喝彩':avg>=55?'忠于舞台':'散场之后',average:Math.round(avg),tour:t});
});

app.use(express.static(join(process.cwd(),'dist-web')));
if(process.env.NODE_ENV!=='test')app.listen(3001,()=>console.log('API listening on http://localhost:3001'));
export { app, tours, flush, closePersist };
