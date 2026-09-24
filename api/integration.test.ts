import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { towns, plays, actions } from './content.js';

// 预置一份“旧存档”：无 schemaVersion、处于已完成阶段、带着脏草稿，
// 用来验证服务启动时的一次性迁移，以及迁移后非法操作仍被拒绝。
const dir = join(tmpdir(),'puppet-test-'+Date.now());
const dataFile = join(dir,'data.json');
const old = {
  id:'old-finished', name:'旧版剧团', seed:9, status:'COMPLETED',
  townIds:towns.slice(0,6).map(t=>t.id), stopIndex:5, funds:300, reputation:70,
  version:4,
  actors:[{id:'mei',name:'梅枝',role:'牵线师',precision:8,acting:6,improvisation:5,stamina:80,trait:'',bio:'',level:3,xp:0,fatigue:1}],
  visited:towns.slice(0,6).map(t=>t.id), clues:{}, unlocked:[],
  history:[{id:'h0',score:80},{id:'h1',score:70}],
  draft:{playId:'moon',assignments:{},timeline:[{actionId:'bow',actorIds:['mei'],act:0,slot:0}],endings:[0,0,0]},
};
mkdirSync(dir,{recursive:true});
writeFileSync(dataFile, JSON.stringify([old]));

process.env.DATA_FILE = dataFile;
process.env.NODE_ENV = 'test';

async function main(){
const mod:any = await import(pathToFileURL(join(__dirname,'server.ts')).href);
const server:Server = createServer(mod.app);
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api/v1`;

async function call(method:string,path:string,body?:any,headers:Record<string,string>={}){
  const r = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const d = await r.json().catch(()=>({}));
  return {status:r.status,d};
}
const expect409=(status:number,d:any)=>{assert.equal(status,409);assert.equal(d.code,'INVALID_TOUR_STATE');};

// ---- 迁移在启动时完成：旧档结构被规范化 ----
const loaded = mod.tours.find((t:any)=>t.id==='old-finished');
assert.equal(loaded.schemaVersion,2);
assert.equal(loaded.draft,undefined,'迁移清掉了脏草稿');
assert.equal(loaded.version,4);

// ---- 旧档升级后，一切非法/回退操作依然被拒绝 ----
{
  const {status,d}=await call('POST','/tours/old-finished/investigations',{kind:'market'});
  expect409(status,d);
}
{
  const {status,d}=await call('PUT','/tours/old-finished/production',{});
  expect409(status,d);
}
{
  const {status,d}=await call('POST','/tours/old-finished/rest',{});
  expect409(status,d);
}
{
  const {status,d}=await call('POST','/tours/old-finished/travel',{townId:'x'});
  expect409(status,d);
}
{
  const {status,d}=await call('POST','/tours/old-finished/performances',{},{'Idempotency-Key':'replay-1'});
  // 按存档隔离：不会因相同键重放他人演出；终局存档本身也禁止演出
  expect409(status,d);
}
{
  const {status,d}=await call('POST','/tours/old-finished/finale',{});
  expect409(status,d);
}

// ---- 新巡演 ----
const {d:created} = await call('POST','/tours',{name:'测试剧团',seed:42});
const id = created.tour.id;
let current:any = created.tour;
let ver = current.version;
assert.equal(ver,1);

const draft=()=>({playId:'moon',timeline:[{actionId:actions[0].id,actorIds:[current.actors[0].id],act:0,slot:0}],endings:[0,0,0]});

// 调查 -> PREPARING
{
  const {status,d}=await call('POST',`/tours/${id}/investigations`,{kind:'market'},{'If-Match':String(ver)});
  assert.equal(status,200);assert.equal(d.tour.status,'PREPARING');assert.equal(d.tour.version,ver+1);current=d.tour;ver=current.version;
}
// 进入 PREPARING 后再调查必须被拒（不能回退到调查阶段重开线索）
{
  const {status,d}=await call('POST',`/tours/${id}/investigations`,{kind:'tavern'});
  expect409(status,d);
}

// 旧修订号并发请求：第一个成功后，拿着旧版本号的迟到请求 409
{
  const rs = await Promise.all([
    call('PUT',`/tours/${id}/production`,draft(),{'If-Match':String(ver)}),
    call('PUT',`/tours/${id}/production`,draft(),{'If-Match':String(ver)}),
    call('PUT',`/tours/${id}/production`,draft(),{'If-Match':String(ver)}),
  ]);
  const oks=rs.filter(r=>r.status===200);const conflicts=rs.filter(r=>r.status===409);
  assert.equal(oks.length,1,'同一修订号的并发保存只有一个成功');
  assert.equal(conflicts.length,2,'其余并发请求受同一版本规则约束而被拒');
  assert.ok(conflicts.every(r=>r.d.code==='VERSION_CONFLICT'));
  current=oks[0].d.tour;ver=current.version;
}

// 非法编排（空时间轴）即使状态正确也被拒
{
  const {status}=await call('PUT',`/tours/${id}/production`,{playId:plays[0].id,timeline:[],endings:[0,0,0]},{'If-Match':String(ver)});
  assert.equal(status,422);
}

// 演出：并发两次（不同幂等键、同一 READY 修订号）只能结算一场
let winningKey='';
{
  const rs = await Promise.all([
    call('POST',`/tours/${id}/performances`,draft(),{'If-Match':String(ver),'Idempotency-Key':'run-a'}),
    call('POST',`/tours/${id}/performances`,draft(),{'If-Match':String(ver),'Idempotency-Key':'run-b'}),
  ]);
  const oks=rs.filter(r=>r.status===200&&!r.d.replayed);
  const blocked=rs.filter(r=>r.status===409);
  assert.equal(oks.length,1,'并发演出只结算一次');
  assert.equal(blocked.length,1);
  assert.ok(['VERSION_CONFLICT','INVALID_TOUR_STATE'].includes(blocked[0].d.code),'迟到的并发请求被同一状态机/版本规则拒绝');
  current=oks[0].d.tour;ver=current.version;winningKey=oks[0].d.performance.idempotencyKey;
  assert.equal(current.status,'ROUTE_SELECTION');
}

// 成功结算用过的幂等键可安全重试，返回同一份快照
{
  const {status,d}=await call('POST',`/tours/${id}/performances`,draft(),{'Idempotency-Key':winningKey});
  assert.equal(status,200);assert.equal(d.replayed,true);assert.equal(d.performance.idempotencyKey,winningKey);
  assert.equal(d.tour.version,ver,'重放不产生第二次结算');
}

// 演出后（ROUTE_SELECTION）再保存编排是非法回退
{
  const {status}=await call('PUT',`/tours/${id}/production`,draft(),{'If-Match':String(ver)});
  assert.equal(status,409);
}
// 演出后补调查同样是非法回退
{
  const {status}=await call('POST',`/tours/${id}/investigations`,{kind:'shrine'},{'If-Match':String(ver)});
  assert.equal(status,409);
}

// 无 If-Match 时回退到纯状态机守卫（向后兼容，但不放松规则）
{
  const next = current.townIds[current.stopIndex+1];
  const {status,d}=await call('POST',`/tours/${id}/travel`,{townId:next});
  assert.equal(status,200,`travel expected ok, got ${status} ${JSON.stringify(d)}`);
  current=d.tour;ver=current.version;
  const again=await call('POST',`/tours/${id}/travel`,{townId:next});
  assert.equal(again.status,409,'并发/重复移动第二次被状态守卫拒绝');
}

mod.closePersist();
await new Promise<void>(r=>server.close(()=>r()));
rmSync(dir,{recursive:true,force:true});
console.log('integration tests passed');
}

main().catch(e=>{console.error(e);process.exit(1);});
