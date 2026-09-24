import assert from 'node:assert/strict';
import { actions, towns } from './content.js';
import { SCHEMA_VERSION, canTransition, migrateTour, migrateTours, validate, findReplay } from './domain.js';

assert.equal(towns.length,8); assert.equal(actions.length,12); assert.ok(actions.every(a=>a.duration>0&&a.stamina>=0));

// ---- 旧存档迁移 ----
const oldSave:any = {
  id:'old-1', name:'老剧团', seed:7, status:'ROUTE_SELECTION', townIds:towns.slice(0,6).map(t=>t.id),
  stopIndex:1, funds:100, reputation:40, version:3,
  actors:[{id:'mei',name:'梅枝',role:'牵线师',precision:8,acting:6,improvisation:5,stamina:70,trait:'',bio:'',level:2,xp:10}],
  visited:[towns[0].id], clues:{}, history:[], unlocked:[],
  // 旧版本可能把脏草稿带到了非编排阶段
  draft:{playId:'moon',assignments:{},timeline:[{actionId:'bow',actorIds:['mei'],act:0,slot:0}],endings:[0,0,0]},
};
const m = migrateTour(oldSave);
assert.equal(m.schemaVersion, SCHEMA_VERSION, '迁移后打上当前结构版本');
assert.equal(m.version, 3, '迁移不得重置并发修订号');
assert.equal(m.draft, undefined, '非编排阶段的脏草稿必须在迁移时清除');
assert.equal(m.actors[0].fatigue, 0, '缺失字段被补默认值');

// 残缺/损坏存档也能被规范化
const broken:any = migrateTour({id:'x', status:'HACKED', actors:'nope'});
assert.equal(broken.status,'INVESTIGATING','非法状态回退到调查阶段');
assert.ok(broken.actors.length===3,'演员列表被重建');
assert.equal(broken.funds,420);
assert.equal(broken.stopIndex,0);
assert.deepEqual(migrateTours(null), []);
// 迁移幂等：再次迁移不产生副作用
assert.equal(migrateTour(broken).schemaVersion, SCHEMA_VERSION);
assert.equal(migrateTour(broken).status,'INVESTIGATING');

// ---- 迁移后非法操作仍被同一状态机拒绝（核心：升级不放宽校验）----
assert.equal(canTransition('INVESTIGATING','investigate'),true);
assert.equal(canTransition('PREPARING','investigate'),false,'准备阶段不能再调查（不能回退）');
assert.equal(canTransition('READY','investigate'),false,'已就绪不能再调查');
assert.equal(canTransition('ROUTE_SELECTION','investigate'),false,'选路阶段不能调查改档');
assert.equal(canTransition('FINALE_READY','investigate'),false);
assert.equal(canTransition('COMPLETED','investigate'),false);
assert.equal(canTransition('PREPARING','saveProduction'),true);
assert.equal(canTransition('READY','saveProduction'),true);
assert.equal(canTransition('ROUTE_SELECTION','saveProduction'),false,'演出后不能再 PUT 编排把状态打回 READY');
assert.equal(canTransition('FINALE_READY','saveProduction'),false);
assert.equal(canTransition('COMPLETED','saveProduction'),false);
assert.equal(canTransition('READY','perform'),true);
assert.equal(canTransition('ROUTE_SELECTION','perform'),false);
assert.equal(canTransition('ROUTE_SELECTION','rest'),true);
assert.equal(canTransition('FINALE_READY','rest'),false,'终局阶段不能通过休息改档');
assert.equal(canTransition('COMPLETED','rest'),false,'已完成存档冻结');
assert.equal(canTransition('FINALE_READY','finale'),true);
assert.equal(canTransition('COMPLETED','finale'),false);
assert.equal(canTransition('ROUTE_SELECTION','travel'),true);
assert.equal(canTransition('COMPLETED','travel'),false);

// ---- 幂等重放按存档隔离 ----
const tA:any = {history:[{id:'p1',idempotencyKey:'k1',score:90}]};
const tB:any = {history:[{id:'p2',idempotencyKey:'other',score:60}]};
assert.equal(findReplay(tA,'k1')?.id,'p1');
assert.equal(findReplay(tB,'k1'),undefined,'别的剧团使用相同幂等键不能命中重放');
assert.equal(findReplay(tA,''),undefined);

// ---- 编排校验 ----
const validDraft:any={playId:'moon',timeline:[{actionId:'bow',actorIds:[m.actors[0].id],act:0,slot:0}],endings:[0,0,0]};
assert.deepEqual(validate(m,validDraft).errors,[]);
assert.ok(validate(m,{playId:'moon',timeline:[],endings:[0,0,0]}).errors.length>0);
// duration=2 的动作占用相邻拍，同演员相邻拍算冲突
const clash:any={playId:'moon',timeline:[
  {actionId:'duel',actorIds:['mei'],act:0,slot:0},
  {actionId:'bow',actorIds:['mei'],act:0,slot:1},
],endings:[0,0,0]};
assert.ok(validate(m,clash).errors.some(e=>e.includes('时间冲突')));

console.log('rules smoke tests passed');
