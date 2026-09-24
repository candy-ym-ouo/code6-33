import { actors, towns, type Actor } from './content.js';

export type Draft = { playId:string; assignments:Record<string,'main'|'support'|'rehearse'|'rest'>; timeline:{actionId:string; actorIds:string[]; act:number; slot:number}[]; endings:number[] };
export type Tour = { id:string; name:string; seed:number; status:string; townIds:string[]; stopIndex:number; funds:number; reputation:number; inspiration:number; version:number; actors:(Actor & {level:number;xp:number;stamina:number;fatigue:number})[]; visited:string[]; clues:Record<string,string[]>; draft?:Draft; history:any[]; unlocked:string[] };
type TourState = Pick<Tour,'status'|'stopIndex'|'townIds'>;

export const STATUSES = ['INVESTIGATING','PREPARING','READY','ROUTE_SELECTION','FINALE_READY','COMPLETED'] as const;

type Rule = { from:readonly string[]; to:(t:TourState)=>string };
// 唯一的状态迁移规则表：任何会改写存档的请求（包括并发到达的）都必须经过这里
export const TRANSITIONS = {
  investigate:    { from:['INVESTIGATING'], to:()=>'PREPARING' },
  saveProduction: { from:['PREPARING','READY'], to:()=>'READY' },
  perform:        { from:['READY'], to:(t:TourState)=>t.stopIndex>=t.townIds.length-1?'FINALE_READY':'ROUTE_SELECTION' },
  travel:         { from:['ROUTE_SELECTION'], to:()=>'INVESTIGATING' },
  rest:           { from:['INVESTIGATING','PREPARING','READY','ROUTE_SELECTION','FINALE_READY'], to:(t:TourState)=>t.status },
  finale:         { from:['FINALE_READY'], to:()=>'COMPLETED' },
} satisfies Record<string,Rule>;
export type TransitionAction = keyof typeof TRANSITIONS;
export const canTransition = (t:{status:string}, action:TransitionAction) => (TRANSITIONS[action].from as readonly string[]).includes(t.status);
export const applyTransition = (t:TourState, action:TransitionAction):string => TRANSITIONS[action].to(t);

export function route(seed:number){let state=(seed>>>0)||1;const shuffled=[...towns];for(let i=shuffled.length-1;i>0;i--){state=(state*1664525+1013904223)>>>0;const j=state%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]}return shuffled.slice(0,6).map(x=>x.id)}

const freshActors = () => actors.slice(0,3).map(a=>({...a,level:1,xp:0,stamina:a.stamina,fatigue:0}));
const clamp = (x:any, lo:number, hi:number, fallback:number) => { const n=Number(x); return Number.isFinite(n)?Math.min(hi,Math.max(lo,n)):fallback };

// 旧存档升级：补齐缺失字段、钳制数值、归一化非法状态；无法识别的记录直接丢弃。
// 升级后的存档与新档受同一套迁移规则约束，非法操作照样被拒绝。
export function migrateTour(raw:any):Tour|null{
  if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||!raw.id)return null;
  const seed=clamp(raw.seed,1,Number.MAX_SAFE_INTEGER,1);
  let townIds=Array.isArray(raw.townIds)?raw.townIds.filter((id:any)=>towns.some(x=>x.id===id)):[];
  if(townIds.length===0)townIds=route(seed);
  const stopIndex=Math.floor(clamp(raw.stopIndex,0,townIds.length-1,0));
  let status:string=(STATUSES as readonly string[]).includes(raw.status)?raw.status:'INVESTIGATING';
  const draft=raw.draft&&typeof raw.draft==='object'?raw.draft as Draft:undefined;
  if(status==='READY'&&!draft)status='PREPARING';
  if(status==='ROUTE_SELECTION'&&stopIndex>=townIds.length-1)status='FINALE_READY';
  const roster=Array.isArray(raw.actors)&&raw.actors.length?raw.actors.map((a:any,i:number)=>{const base=actors.find(x=>x.id===a?.id)||actors[i%actors.length];return {...base,...a,id:typeof a?.id==='string'&&a.id?a.id:base.id,level:Math.floor(clamp(a?.level,1,99,1)),xp:Math.floor(clamp(a?.xp,0,1e9,0)),stamina:clamp(a?.stamina,10,100,base.stamina),fatigue:clamp(a?.fatigue,0,3,0)}}):freshActors();
  return {id:raw.id,name:String(raw.name||'未命名剧团').trim().slice(0,24)||'未命名剧团',seed,status,townIds,stopIndex,funds:clamp(raw.funds,0,1e9,0),reputation:clamp(raw.reputation,0,100,50),inspiration:clamp(raw.inspiration,0,1e9,0),version:Math.floor(clamp(raw.version,1,1e9,1)),actors:roster,visited:Array.isArray(raw.visited)?raw.visited.filter((x:any)=>typeof x==='string'):[],clues:raw.clues&&typeof raw.clues==='object'&&!Array.isArray(raw.clues)?raw.clues:{},draft,history:Array.isArray(raw.history)?raw.history:[],unlocked:Array.isArray(raw.unlocked)?raw.unlocked:[]};
}

// 每个存档一条串行队列：并发写请求按到达顺序逐个执行，每个都在执行时重新过一遍迁移规则
export function createSerializer(){
  const tails=new Map<string,Promise<unknown>>();
  function enqueue<T>(key:string,task:()=>T|Promise<T>):Promise<T>{
    const run=(tails.get(key)??Promise.resolve()).then(()=>task());
    const tail=run.catch(()=>{});
    tails.set(key,tail);
    tail.then(()=>{if(tails.get(key)===tail)tails.delete(key)});
    return run;
  }
  return enqueue;
}
