import {createMessagePreparer as prepare,buildEventMessage,buildOverviewMessage} from './src/messages.ts';
import {createPngRenderer,renderOverview,fitText} from './src/render.ts';
import {nativeStatus} from './src/status-style.ts';
import {displayBranch,displayCounts} from './src/display-model.ts';
export {createPngRenderer,renderOverview,buildEventMessage,buildOverviewMessage,nativeStatus,displayBranch,displayCounts};
// This metadata is neither serialized nor saved. Cloned/absent controls fail closed.
const contexts=new WeakMap();
function sourcesFor(p){const branches=p.overview??[];const historical=(p.historical_sources??[]).filter(s=>branches.some(b=>b.source_id===s.source_id));return [...new Map([...historical,...(p.sources??[])].map(s=>[s.source_id,{...s,verification_status:s.connection_status==='verified'?'verified':'needs_reverification'}])).values()];}
export function createMessagePreparer(renderer,options={}) {
 const next=prepare(renderer,{...options,utcOffsetMinutes:options.utcOffsetMinutes??480});
 return dispatch=>{const p=dispatch.payload??{};const context=contexts.get(p.components);const matched=context?.revision===p.revision?context:undefined;
 const sources=sourcesFor(p),rendered_at=new Date(Math.max(options.clock?.()??Date.now(),Date.parse(p.rendered_at??'')||0)).toISOString();
 const components=p.components?.map(row=>({...row,components:row.components?.map(c=>c.type===3?{...c,options:c.options?.map(o=>{
  const key=matched?.routes.get(JSON.stringify([c.custom_id,o.value]));
  const branch=key?(p.overview??[]).find(b=>b.branch_key===key):undefined;
  if(branch){const view=displayBranch(branch,{sources,rendered_at,requests:matched.requests});return {...o,label:`${fitText(view.taskName,48-3-view.state.label.length)} · ${view.state.label}`};}
  return {...o,label:typeof o.label==='string'?o.label.replace(/ · 待你处理$/,' · 等待输入'):o.label};
 })}:c)}));
 return next({...dispatch,payload:{...p,components,sources,display_requests:matched?.requests??[],rendered_at}});};
}
export function decorateControls(core,controls,revision) {
 const snapshot=core.snapshot(),selection=core.selection(),rendered_at=new Date(core.clock()).toISOString();
 const context={revision,routes:new Map(),requests:(snapshot.requests??[]).map(r=>({...r})),rendered_at};contexts.set(controls,context);
 const sources=snapshot.sources.map(s=>({...s,verification_status:s.connection_status==='verified'?'verified':'needs_reverification'}));
 for(const row of controls)for(const component of row.components??[]){if(component.type!==3)continue;
 if(['选择 PA 来源','来源 · 已验证'].includes(component.placeholder)){
  component.placeholder='来源 · 已验证';for(const option of component.options){if(option.value==='all')continue;
   const counts=displayCounts(snapshot.branches.filter(b=>!b.archived&&core.canNotify(b)&&b.source_id===option.value),{...context,sources});
   option.description=`已验证 · ${counts.tasks} 个任务 / ${counts.branches} 个分支`;if(selection.source_id===option.value)option.default=true;}
 }else if(['选择当前页路线详情','查看任务详情'].includes(component.placeholder)){
  component.placeholder='查看任务详情';const stored=core.one('SELECT payload FROM controls WHERE ref=?',component.custom_id);const entries=stored?JSON.parse(stored.payload):[];
  for(const option of component.options){if(option.value==='all'){option.label='当前页全部分支';continue;}const key=entries.find(x=>x.value===option.value)?.branch_key;const branch=snapshot.branches.find(b=>b.branch_key===key);
   if(branch){context.routes.set(JSON.stringify([component.custom_id,option.value]),branch.branch_key);const view=displayBranch(branch,{...context,sources});option.label=`${fitText(view.taskName,48-3-view.state.label.length)} · ${view.state.label}`;option.description=fitText(`${view.sourceName} / ${view.projectName} · ${view.branchName}`,48);if(selection.branch_key===key)option.default=true;}}
 }}return controls;
}
