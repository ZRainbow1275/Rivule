/** Pure display semantics; never mutates state, creates actions, or guesses next steps. */
import type {BranchView,SourceView} from './render.ts';
export type RequestEvidence={request_key?:string;branch_key?:string;request_id?:string;state?:string;version?:number};
export type DisplayContext={rendered_at:string;sources?:SourceView[];requests?:RequestEvidence[];request?:RequestEvidence;review?:boolean};
export type DisplayState={label:string;symbol:string;color:string;wash:string;shape:string};
const styles:Record<string,DisplayState>={
 proposed:{label:'待开始',symbol:'○',color:'#657079',wash:'#F0F2F3',shape:'circle'},
 running:{label:'进行中',symbol:'▶',color:'#285F9C',wash:'#EBF2FC',shape:'play'},
 needs_input:{label:'等待输入',symbol:'Ⅱ',color:'#875914',wash:'#FFF5DC',shape:'pause'},
 actionable:{label:'待你处理',symbol:'Ⅱ',color:'#875914',wash:'#FFF5DC',shape:'pause'},
 completed:{label:'已完成',symbol:'✓',color:'#246B51',wash:'#EAF5EF',shape:'check'},
 failed:{label:'失败',symbol:'◆',color:'#A33E36',wash:'#FFF1EE',shape:'diamond'},
 blocked:{label:'受阻',symbol:'◆',color:'#A33E36',wash:'#FFF1EE',shape:'diamond'},
 cancelled:{label:'已取消',symbol:'○',color:'#657079',wash:'#F0F2F3',shape:'circle'},
 review:{label:'状态待核对',symbol:'◇',color:'#875914',wash:'#FFF5DC',shape:'diamond'},
 unknown:{label:'状态未知',symbol:'○',color:'#657079',wash:'#F0F2F3',shape:'circle'}
};
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
export const taskKey=(b:BranchView)=>JSON.stringify([b.source_id,b.project_id,b.task_id]);
export const branchKey=(b:BranchView)=>typeof b.branch_key==='string'?b.branch_key:JSON.stringify([b.source_id,b.task_id,b.run_id,b.branch_id]);
export function expiryElapsed(b:BranchView,asOf:string){const expiry=Date.parse(b.action?.expires_at??''),now=Date.parse(asOf);return b.source_status==='needs_input'&&Number.isFinite(expiry)&&Number.isFinite(now)&&expiry<=now;}
function matchingRequest(b:BranchView,r?:RequestEvidence):boolean {
 if(!r||r.branch_key&&r.branch_key!==branchKey(b)||!Number.isSafeInteger(r.version)||r.version!<1)return false;
 if(b.state_version!==undefined&&r.version!==b.state_version)return false;
 let id=r.request_id;
 if(typeof r.request_key==='string'){try{const key=JSON.parse(r.request_key);if(!Array.isArray(key)||key.length!==2||key[0]!==branchKey(b)||id!==undefined&&id!==key[1])return false;id=key[1];}catch{return false;}}
 return typeof id==='string'&&id===b.action?.request_id;
}
export function displayBranch(b:BranchView,context:DisplayContext) {
 const source=context.sources?.find(s=>s.source_id===b.source_id);
 const request=context.request&&matchingRequest(b,context.request)?context.request:context.requests?.find(r=>matchingRequest(b,r));
 const action=b.action,expiry=action?.expires_at,hasExpiry=expiry!==null&&expiry!==undefined;
 const validAction=b.source_status==='needs_input'&&action&&text(action.request_id)&&text(action.question)&&action.mode==='return_to_source'&&(!hasExpiry||typeof expiry==='string'&&Number.isFinite(Date.parse(expiry)));
 const sourceCurrent=source?.enabled===true&&source?.selectable===true&&source?.connection_status==='verified'&&source?.verification_status==='verified';
 const actionable=!!(validAction&&request?.state==='pending'&&sourceCurrent&&!b.stale&&!context.review&&!expiryElapsed(b,context.rendered_at));
 const sourceWarning=source?.enabled===false||source?.connection_status==='disabled'?'来源已停用':source?.connection_status==='revoked'?'接入已撤销':source?.connection_status==='disconnected'?'来源失联':source?.connection_status==='stale'?'来源久未更新':source?.verification_status&&source.verification_status!=='verified'?'待重新验证':'';
 const warning=context.review?'更新与已知状态冲突，尚未覆盖当前记录':b.stale?'信息已过期，当前状态待核对':sourceWarning?sourceWarning+'，当前状态待核对':expiryElapsed(b,context.rendered_at)?'请求期限已过，请回原平台核对':request?.state==='expired'?'请求已过期，请回原平台核对':request&&request.state!=='pending'&&b.source_status==='needs_input'?'请求状态已变化，请回原平台核对':'';
 const execution=styles[b.blocker?'blocked':actionable?'actionable':b.source_status]??styles.unknown;
 const state=context.review?styles.review:execution;
 let progress='';const p=b.progress;
 if(p!==null&&p!==undefined){if(typeof p.done==='number'&&Number.isFinite(p.done)&&p.done>=0&&text(p.unit)&&((p.total===null||p.total===undefined)||(typeof p.total==='number'&&Number.isFinite(p.total)&&p.total>0&&p.done<=p.total)))progress=p.total==null?`已报告 ${p.done} ${text(p.unit)}（总量未知）`:`已报告 ${p.done} / ${p.total} ${text(p.unit)}`;else progress='已报告数量待核对';}
 return {branch:b,state,actionable,warning,sourceName:source?.display_name??b.source_id,projectName:text(b.project_name)||b.project_id,taskName:text(b.task_name)||b.task_id,branchName:text(b.branch_name)||b.branch_id,summary:text(b.summary),blocker:text(b.blocker),question:actionable?text(action.question):'',impact:actionable&&text(action.impact)!=='未提供'?text(action.impact):'',deadline:actionable&&hasExpiry?expiry:'',phase:text(b.phase_label),progress,updatedAt:b.last_confirmed_at??b.occurred_at,taskKey:taskKey(b),branchKey:branchKey(b)};
}
export type DisplayBranch=ReturnType<typeof displayBranch>;
export function displayCounts(branches:BranchView[],context:DisplayContext){return {tasks:new Set(branches.map(taskKey)).size,branches:branches.length,actionableTasks:new Set(branches.filter(b=>displayBranch(b,context).actionable).map(taskKey)).size};}
