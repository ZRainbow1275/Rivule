/** Discord payloads for the fixed-owner DM. Navigation components are attached by
 * the server-side selection layer; pixels and request notices never grant approval.
 */
import {nativeStatus} from './status-style.ts';
import type {Dispatch} from './owner.ts';
import {safeUrl} from './contracts.ts';
import {displayTime,renderOverview,stateLabel,progressLabel,attentionLabel,fitText,STATUS_LABELS,requestExpired} from './render.ts';
import type {Graph,PngRenderer,Snapshot,SourceView} from './render.ts';

export function utf16Limit(value:string,max:number):string {let out='';for(const char of value){if(out.length+char.length>max)break;out+=char;}return out;}
export function safeDiscord(value:unknown,max=1000):string {
 const s=typeof value==='string'?value:'';
 // Preserve useful newlines in native embeds; scrub bidi/control injection.
 const cleaned=s.slice(0,8000).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[\ud800-\udfff]/gu,'�');
 return utf16Limit(cleaned.replace(/@/g,'@\u200b').replace(/[\\`*_{}\[\]<>|~]/g,'\\$&'),max);
}
export function snapshotFromDispatch(dispatch:Dispatch):Snapshot {
 const p=dispatch.payload??{};
 return {branches:p.overview??[],sources:p.sources??[],selection:p.selection??{},rendered_at:p.rendered_at??new Date().toISOString(),test_only:p.test_only===true,revision:p.revision??0,utc_offset_minutes:p.utc_offset_minutes};
}
const mentionPolicy=()=>({parse:[]});
const sourceFor=(sources:SourceView[],id:string)=>sources.find(s=>s.source_id===id);
function originalButton(event:any,sources:SourceView[],closed=false):any[] {
 const source=sourceFor(sources,event.source_id);
 // Validation at ingress binds links to source allowed_hosts. This additional
 // boundary rejects unsafe schemes, credentials, fragments and query strings.
 let url:string|null=null;try{url=safeUrl(event.source_url);}catch{}
 if(!url||source?.enabled===false)return [];
 return [{type:1,components:[{type:2,style:5,label:closed?'查看原任务':'回原任务查看',url}]}];
}
export function buildOverviewMessage(snapshot:Snapshot):{payload:any;graph:Graph} {
 const graph=renderOverview(snapshot);
 const fields=graph.rows.map(b=>({
  name:safeDiscord(`${nativeStatus(b).symbol} ${fitText(b.task_name??b.task_id,25)} · ${fitText(b.branch_name??b.branch_id,20)}`,190),
  value:safeDiscord(`${requestExpired(b,graph.rendered_at)?'请求期限已过 · 原平台待核对':nativeStatus(b).label} · ${b.phase_label??'阶段未提供'}\n${progressLabel(b)}\n${attentionLabel(b,graph.rendered_at)}\n来源确认 ${displayTime(b.last_confirmed_at??b.occurred_at)}${b.stale?' · 信息已过期':''}`,950),inline:false
 }));
 if(snapshot.selection?.branch_key&&graph.rows.length===1){
  const b=graph.rows[0],selected=snapshot.selection.selected_node_id;
  const node=selected?graph.nodes.find(n=>n.phase_id===selected||n.node_id===selected):undefined;
  fields.push({name:'完整路线名称',value:safeDiscord(`${b.project_name??b.project_id} › ${b.task_name??b.task_id} › ${b.branch_name??b.branch_id}`,950),inline:false});
  if(b.summary&&(b.blocker||b.source_status==='needs_input'))fields.push({name:'任务摘要',value:safeDiscord(b.summary,950),inline:false});
  if(node)fields.push({name:safeDiscord('选中阶段 · '+(node.label??'阶段未提供'),190),value:safeDiscord(`${node.summary??'该阶段未保存摘要；当前路线内容不可当作历史阶段记录。'}\n阶段时间 ${displayTime(node.occurred_at)}`,950),inline:false});
 }
 const description=(snapshot.test_only?'演示':'')+(graph.missingGlyphs?' · 部分字符请查看下方详情':'');
 return {graph,payload:{content:'Rivule · 进展',allowed_mentions:mentionPolicy(),embeds:[{title:snapshot.selection?.branch_key?'任务详情':'任务总览',description,color:graph.rows.length===1?nativeStatus(graph.rows[0]).color:0x6577A5,fields,footer:{text:`第 ${graph.page+1}/${graph.pages} 页 · ${graph.total} 条路线`},image:{url:'attachment://progress.png'}}],attachments:[{id:'0',filename:'progress.png',description:'按 PA、项目任务和并行路线分组的已知阶段；静态图片，用消息选择器操作'}],components:[]}};
}
export function buildEventMessage(dispatch:Dispatch):any {
 const p=dispatch.payload??{},event=p.event??{},sources:SourceView[]=p.sources??[];
 const source=sourceFor(sources,event.source_id),sourceName=source?.display_name??event.source_id??'未标记来源';
 const project=event.project_name??event.project_id??'',task=event.task_name??event.task_id??'';
 const hierarchy=project&&task&&(project.includes(task)||task.includes(project))?[project.length>=task.length?project:task]:[project,task];
 const location=[sourceName,...hierarchy,event.branch_name??event.branch_id??''].filter(Boolean).join(' › ');
 const suffix=p.test_only===true?'（本地演示）':'';
 if(p.intent==='request'){
  const request=p.request??{},action=event.action??{};
  const states:Record<string,string>={pending:'等待你回原平台处理',resolved_by_source:'原任务已不再等待此请求',changed:'请求已变化',expired:'请求已过期'};
  const pending=request.state==='pending';
  const state=states[request.state]??'请求状态未知，请回原平台核对';
  const title=pending?'Ⅱ 待你决定':request.state==='expired'?'○ 请求已过期':'○ 请求已更新';
  const description=`${location}\n${action.question??'请在原平台查看请求'}\n影响：${action.impact??'未提供'}\n期限：${action.expires_at?displayTime(action.expires_at):'未设置'}\n状态：${state}\n打开原任务不等于批准；确认必须在原平台完成。`;
  return {content:safeDiscord(title+suffix,200),allowed_mentions:mentionPolicy(),embeds:[{title,description:safeDiscord(description,3500),color:pending?0x875914:0x71818A,footer:{text:`请求版本 ${Number.isSafeInteger(request.version)?request.version:'未知'}`}}],components:p.test_only===true?[]:originalButton(event,sources,!pending),attachments:[]};
 }
 const review=p.intent==='review';
 const visual=nativeStatus(event);
 const title=review?'◆ 更新待核对':`${visual.symbol} ${visual.label}`;
 let description=`${location}\n${event.blocker?'阻塞：'+event.blocker+'\n':''}${event.summary??'来源未提供摘要'}\n来源发生时间 ${displayTime(event.occurred_at)}`;
 if(review){description+='\n更新与已知顺序或终态不一致，已保留，尚未覆盖任务状态。';if(event.action)description+=`\n待核对的请求：${event.action.question??''}\n影响：${event.action.impact??'未提供'}`;}
 return {content:safeDiscord(title+suffix,200),allowed_mentions:mentionPolicy(),embeds:[{title,description:safeDiscord(description,3500),color:review?0x875914:visual.color}],components:p.test_only===true?[]:originalButton(event,sources,true),attachments:[]};
}
/** Compatible with DiscordConfig.prepare; components may be added by its caller. */
export function createMessagePreparer(renderer:PngRenderer,options:{scale?:1|2;utcOffsetMinutes?:number}={}) {
 return async(dispatch:Dispatch):Promise<{payload:any;png?:Uint8Array}>=>{
  if(dispatch.payload?.intent!=='overview')return {payload:buildEventMessage(dispatch)};
  const {payload,graph}=buildOverviewMessage({...snapshotFromDispatch(dispatch),utc_offset_minutes:options.utcOffsetMinutes??snapshotFromDispatch(dispatch).utc_offset_minutes});
  payload.components=dispatch.payload.components??[];
  const png=await renderer(graph,options.scale??2);
  return {payload,png};
 };
}
