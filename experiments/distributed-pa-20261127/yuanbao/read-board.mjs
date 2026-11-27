/* Bounded read-only bridge experiment; no OAuth endpoint, credentials or callbacks.
 * loadJournal and resolve are trusted host dependencies. Nothing dispatches here. */
import {projectBoard} from '../src/sdk/coordination-board.mjs';
const name=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(x);
const trustedViews=new Set(['owner','yuanbao','muse-personal']);
const states=new Set(['ready','blocked','leased','submitting','running','needs_review','reported','accepted','failed','canceled']);
const delivery=new Set(['unknown','owner_review','throttled','rejected','input_observed']);
const own=(o,k)=>Object.hasOwn(o,k);
const err=code=>Object.assign(new Error(code),{code});
const requireThat=(p,code)=>{if(!p)throw err(code)};
const deepFreeze=o=>{if(o&&typeof o==='object'){for(const a of Object.values(o))deepFreeze(a);Object.freeze(o)}return o};
const object=(props,keys=[])=>({type:'object',properties:props,required:keys,additionalProperties:false});
export const tools=deepFreeze([
 {name:'list_board_status',description:'读取授权看板，或按验收与依赖状态筛选',inputSchema:object({filter:{enum:['all','accepted','blocked']}}),annotations:{readOnlyHint:true}},
 {name:'get_task_status',description:'根据授权展示代号读取任务状态',inputSchema:object({alias:{type:'string',pattern:'^[A-Z][A-Z0-9]{0,7}$'}},['alias']),annotations:{readOnlyHint:true}},
]);
const validAlias=x=>typeof x==='string'&&/^[A-Z][A-Z0-9]{0,7}$/.test(x);
const texts={blocked:'等待前置验收',ready:'待领取',leased:'已领取',submitting:'投递中',running:'已收到',needs_review:'待核对',reported:'已交稿',accepted:'已验收',failed:'失败',canceled:'已取消'};
const labels={owner_review:'待所有者审核',throttled:'限流',rejected:'明确拒绝',input_observed:'已见原输入、仍待核',unknown:'投递结果待核'};
const exact=(o,fields)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).every(k=>fields.includes(k))&&Object.keys(o).every(k=>'value' in Object.getOwnPropertyDescriptor(o,k));
function safeCards(j,p,aliases){
 // j is one durable snapshot. projectBoard has validated the complete journal.
 // Track evidence just for the current attempt, including running→uncertain.
 const evidence=new Map();
 for(const e of j.events){
  const c=e.command;
  if(c.type==='claim'||c.type==='add'||(c.type==='reconcile'&&e.meta.answer?.verdict==='closed_not_sent'))evidence.delete(c.task);
  if(c.type==='acknowledged'||(c.type==='reconcile'&&['result_verified','failure_verified'].includes(e.meta.answer?.verdict)))evidence.set(c.task,'confirmed');
  if(c.type==='reconcile'&&e.meta.answer?.verdict==='input_verified')evidence.set(c.task,'input_only');
 }
 const aliasByTask=new Map([...aliases].map(([a,id])=>[id,a]));
 return p.cards.map(c=>{
  requireThat(states.has(c.state),'view_unavailable');
  const readback=c.deliveryState&&delivery.has(c.deliveryState)?c.deliveryState:null;
  return {alias:aliasByTask.get(c.task),state:c.state,label:texts[c.state],delivery:{
   evidence:evidence.get(c.task)??(c.state==='needs_review'?'uncertain':'not_confirmed'),
   reviewLabel:readback?labels[readback]:null},
   submitted:c.state==='reported'||c.state==='accepted',accepted:c.state==='accepted',
   updatedAt:new Date(j.events[c.taskVersion-1].at).toISOString(),
   revision:c.taskVersion,dependencies:c.dependencies.map(d=>({alias:aliasByTask.get(d.task),state:d.state,accepted:d.state==='accepted'}))};
 });
}
export function createBoardReadBridge({resolve,loadJournal,demoBoard}){
 requireThat(name(demoBoard)&&[resolve,loadJournal].every(x=>typeof x==='function'),'host_binding_required');
 function access(p){
  requireThat(p?.active===true&&p.board===demoBoard&&trustedViews.has(p.audience)&&name(p.subject)&&
    p.rights instanceof Set&&p.rights.has('pa:board:read')&&p.aliases instanceof Map&&p.aliases.size<=128,'not_authorized');
  const aliases=new Map(p.aliases);const ids=[...aliases.values()];
  requireThat([...aliases.keys()].every(validAlias)&&ids.every(name)&&new Set(ids).size===ids.length,'view_unavailable');
  return {aliases,ids,identity:[p.board,p.subject,p.audience]};
 }
 return Object.freeze({tools,async invoke(request,method,args){
  requireThat(tools.some(x=>x.name===method),'unknown_tool');
  requireThat(exact(args,method==='get_task_status'?['alias']:['filter']),'invalid_input');
  if(method==='get_task_status')requireThat(validAlias(args.alias),'invalid_input');
  else requireThat(!own(args,'filter')||['all','accepted','blocked'].includes(args.filter),'invalid_input');
  const p=await resolve(request);
  const {aliases,ids,identity}=access(p);
  const j=await loadJournal({board:demoBoard,subject:p.subject,audience:p.audience});
  requireThat(j?.scope===demoBoard,'view_unavailable');
  // Recheck at the release boundary: one read can straddle a revocation.
  const refreshed=access(await resolve(request));
  requireThat(identity.every((x,i)=>x===refreshed.identity[i])&&aliases.size===refreshed.aliases.size&&
   [...aliases].every(([a,id])=>refreshed.aliases.get(a)===id),'not_authorized');
  const view=projectBoard(j,{scope:demoBoard,selected:ids,readable:ids});
  const cards=safeCards(j,view,aliases);
  if(method==='get_task_status')return {asOfVersion:view.asOfVersion,card:cards.find(c=>c.alias===args.alias)??null};
  const f=args.filter??'all';
  return {asOfVersion:view.asOfVersion,cards:cards.filter(c=>f==='all'||c.state===f)};
 }});
}
