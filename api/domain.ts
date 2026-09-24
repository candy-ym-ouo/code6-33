import { actors as allActors, actions, plays, type Actor } from './content.js';

export type Draft = { playId:string; assignments:Record<string,'main'|'support'|'rehearse'|'rest'>; timeline:{actionId:string; actorIds:string[]; act:number; slot:number}[]; endings:number[] };
export type Tour = { id:string; name:string; seed:number; status:string; townIds:string[]; stopIndex:number; funds:number; reputation:number; inspiration:number; version:number; schemaVersion:number; actors:(Actor & {level:number;xp:number;stamina:number;fatigue:number})[]; visited:string[]; clues:Record<string,string[]>; draft?:Draft; history:any[]; unlocked:string[] };

// 当前存档结构版本。旧存档（无 schemaVersion 字段）在加载时一次性迁移到该版本。
export const SCHEMA_VERSION = 2;

export const STATUSES = ['INVESTIGATING','PREPARING','READY','ROUTE_SELECTION','FINALE_READY','COMPLETED'] as const;

// 每个“动作 -> 后继状态”允许执行的前置阶段。这是唯一的状态机事实来源，
// 迁移、HTTP 守卫、并发请求都受同一张表约束。
export const TRANSITIONS:Record<string,readonly string[]> = {
  investigate: ['INVESTIGATING'],
  saveProduction: ['PREPARING','READY'],
  perform: ['READY'],
  travel: ['ROUTE_SELECTION'],
  rest: ['ROUTE_SELECTION','PREPARING','READY'],
  finale: ['FINALE_READY'],
};

export function canTransition(status:string, action:keyof typeof TRANSITIONS):boolean {
  return TRANSITIONS[action].includes(status);
}

// 旧存档升级：纯函数，只做结构规范化，从不放宽状态机。
// 迁移后存档处于哪个阶段，仍由 TRANSITIONS 决定哪些操作合法。
export function migrateTour(raw:any):Tour {
  const t:Tour = raw && typeof raw === 'object' ? raw : {};
  if (!Array.isArray(t.townIds) || t.townIds.length === 0) t.townIds = [];
  if (!Number.isFinite(t.stopIndex) || t.stopIndex < 0) t.stopIndex = 0;
  if (!Number.isFinite(t.funds)) t.funds = 420;
  if (!Number.isFinite(t.reputation)) t.reputation = 50;
  if (!Number.isFinite(t.inspiration)) t.inspiration = 3;
  if (!Array.isArray(t.visited)) t.visited = [];
  if (!t.clues || typeof t.clues !== 'object') t.clues = {};
  if (!Array.isArray(t.history)) t.history = [];
  if (!Array.isArray(t.unlocked)) t.unlocked = [];
  if (!Array.isArray(t.actors) || t.actors.length === 0) {
    t.actors = allActors.slice(0,3).map(a=>({...a,level:1,xp:0,stamina:a.stamina,fatigue:0}));
  } else {
    for (const a of t.actors) {
      if (!Number.isFinite(a.level)) a.level = 1;
      if (!Number.isFinite(a.xp)) a.xp = 0;
      if (!Number.isFinite(a.stamina)) a.stamina = 60;
      if (!Number.isFinite(a.fatigue)) a.fatigue = 0;
    }
  }
  if (!STATUSES.includes(t.status as typeof STATUSES[number])) t.status = 'INVESTIGATING';
  // 编排草稿只允许存在于 PREPARING/READY：旧版本可能把脏草稿带到了其它阶段，
  // 迁移时清掉，避免演出/移动后凭旧草稿把状态打回去。
  if (t.draft !== undefined && t.status !== 'PREPARING' && t.status !== 'READY') t.draft = undefined;
  // version 是乐观并发修订号：任何一次状态变更都会自增。
  if (!Number.isInteger(t.version) || t.version < 0) t.version = 1;
  t.schemaVersion = SCHEMA_VERSION;
  return t as Tour;
}

export function migrateTours(raw:any):Tour[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(migrateTour);
}

export function validate(t:Tour,d:Partial<Draft>){
  const errors:string[]=[];
  if(!d||typeof d!=='object')return {errors:['编排数据格式错误'],p:undefined};
  const p=plays.find(x=>x.id===d.playId);
  if(!p)errors.push('剧目不存在');
  const timeline=Array.isArray(d.timeline)?d.timeline:[];
  if(timeline.length===0)errors.push('至少安排一个木偶动作');
  const seen=new Set<string>();
  for(const e of timeline){
    if(!e||typeof e!=='object'){errors.push('动作数据格式错误');continue}
    const a=actions.find(x=>x.id===e.actionId);
    if(!a)errors.push('包含未知动作');
    if(!Number.isInteger(e.slot)||!Number.isInteger(e.act)||e.slot<0||e.slot>3||e.act<0||e.act>2)errors.push('动作位置超出时间轴');
    const ids=Array.isArray(e.actorIds)?e.actorIds:[];
    if(ids.length===0)errors.push('每个动作至少需要一名演员');
    for(const id of ids){
      if(!t.actors.some(actor=>actor.id===id))errors.push('包含未知演员');
      const occupied=`${id}-${e.act}-${e.slot+((a?.duration||1)-1)}`;
      if(seen.has(occupied))errors.push('同一演员存在时间冲突');
      seen.add(occupied);
    }
  }
  for(const a of t.actors){
    const used=timeline.filter(e=>Array.isArray(e?.actorIds)&&e.actorIds.includes(a.id)).reduce((n,e)=>n+(actions.find(x=>x.id===e.actionId)?.stamina||0),0);
    if(used>a.stamina+10)errors.push(`${a.name}体力不足`);
  }
  const endings=Array.isArray(d.endings)?d.endings:[];
  if(endings.length!==3||endings.some(x=>!Number.isInteger(x)||x<0||x>2))errors.push('结局选择不完整');
  return {errors,p};
}

// 按存档隔离的幂等重放查找：同一剧团同一键返回原演出，不同剧团互不影响。
export function findReplay(t:Tour,key:string){
  if(!key)return undefined;
  return t.history.find((x:any)=>x.idempotencyKey===key);
}
