import assert from 'node:assert/strict';
import { actions, towns } from './content.js';
import { canTransition, applyTransition, migrateTour, createSerializer, route } from './rules.js';

assert.equal(towns.length,8); assert.equal(actions.length,12); assert.ok(actions.every(a=>a.duration>0&&a.stamina>=0));

// route 不得污染共享的小镇列表
const before=towns.map(x=>x.id).join(','); route(42); route(7); assert.equal(towns.map(x=>x.id).join(','),before);

// 迁移规则：只有调查阶段能调查，只有筹备/就绪阶段能改档，终幕后存档只读
const at=(status:string,stopIndex=0)=>({status,stopIndex,townIds:['lantern','reed']});
assert.equal(canTransition(at('INVESTIGATING'),'investigate'),true);
for(const s of ['PREPARING','READY','ROUTE_SELECTION','FINALE_READY','COMPLETED'])assert.equal(canTransition(at(s),'investigate'),false,`investigate@${s}`);
for(const s of ['PREPARING','READY'])assert.equal(canTransition(at(s),'saveProduction'),true,`saveProduction@${s}`);
for(const s of ['INVESTIGATING','ROUTE_SELECTION','FINALE_READY','COMPLETED'])assert.equal(canTransition(at(s),'saveProduction'),false,`saveProduction@${s}`);
assert.equal(canTransition(at('COMPLETED'),'rest'),false);
assert.equal(canTransition(at('READY'),'rest'),true);
assert.equal(canTransition(at('COMPLETED'),'perform'),false);
assert.equal(applyTransition(at('READY',0),'perform'),'ROUTE_SELECTION');
assert.equal(applyTransition(at('READY',1),'perform'),'FINALE_READY');

// 旧存档升级：缺字段补齐、非法状态归一化，升级后非法操作仍被拒绝
const legacy=migrateTour({id:'old',name:'旧剧团',status:'COMPLETED',funds:-50});
assert.ok(legacy); assert.equal(legacy.status,'COMPLETED'); assert.equal(legacy.version,1); assert.equal(legacy.funds,0);
for(const a of ['investigate','saveProduction','perform','travel','rest','finale'] as const)assert.equal(canTransition(legacy,a),false,`legacy@${a}`);
const weird=migrateTour({id:'mystery',status:'SOME_LEGACY_STATE',stopIndex:42,townIds:['ghost']});
assert.ok(weird); assert.equal(weird.status,'INVESTIGATING'); assert.equal(weird.stopIndex,5); assert.equal(weird.townIds.length,6);
assert.equal(canTransition(weird,'investigate'),true); assert.equal(canTransition(weird,'perform'),false);
assert.equal(migrateTour({id:'r',status:'READY'})!.status,'PREPARING');
assert.equal(migrateTour(null),null); assert.equal(migrateTour({name:'x'}),null); assert.equal(migrateTour('junk'),null);

// 并发：同一串行队列下，检查+迁移原子生效，N 个并发请求只有一个能通过
const run=(async()=>{
  const serialize=createSerializer();
  const tour=at('INVESTIGATING');
  const attempt=()=>serialize('tour-1',()=>canTransition(tour,'investigate')?(tour.status=applyTransition(tour,'investigate'),'ok'):'rejected');
  const results=await Promise.all([attempt(),attempt(),attempt(),attempt()]);
  assert.deepEqual([...results].sort(),['ok','rejected','rejected','rejected']);
  assert.equal(tour.status,'PREPARING');
  console.log('rules smoke tests passed');
})();
run.catch(e=>{console.error(e);process.exit(1)});
