/** Native text and graph read the same display model. Navigation never approves. */
import {displayBranch} from './display-model.ts';
import type {Dispatch} from './dispatch.ts';
import {safeUrl} from './contracts.ts';
import {displayTime,renderOverview,fitText} from './render.ts';
import type {Graph,PngRenderer,Snapshot,SourceView} from './render.ts';
export function utf16Limit(value:string,max:number):string {let out='';for(const char of value){if(out.length+char.length>max)break;out+=char;}return out;}
export function safeDiscord(value:unknown,max=1000):string {const s=typeof value==='string'?value:'';const cleaned=s.slice(0,8000).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[\ud800-\udfff]/gu,'�');return utf16Limit(cleaned.replace(/@/g,'@\u200b').replace(/[\\`*_{}\[\]<>|~]/g,'\\$&'),max);}
const clipNative=(value:string,max:number)=>{const full=safeDiscord(value,8000);return full.length>max?utf16Limit(full,max-1)+'…':full;};
export function snapshotFromDispatch(dispatch:Dispatch):Snapshot {const p=dispatch.payload??{};return {branches:p.overview??[],sources:p.sources??[],selection:p.selection??{},rendered_at:p.rendered_at??new Date().toISOString(),test_only:p.test_only===true,revision:p.revision??0,utc_offset_minutes:p.utc_offset_minutes,requests:p.display_requests??[]};}
const mentionPolicy=()=>({parse:[]});
function originalButton(event:any,sources:SourceView[],label='打开原任务'):any[] {const source=sources.find(s=>s.source_id===event.source_id);let url:string|null=null;try{url=safeUrl(event.source_url);}catch{}if(!url||source?.enabled===false)return [];return [{type:1,components:[{type:2,style:5,label,url}]}];}
const asTime=(v:unknown)=>displayTime(v);
export function buildOverviewMessage(snapshot:Snapshot):{payload:any;graph:Graph} {
 const graph=renderOverview(snapshot),detail=!!snapshot.selection?.branch_key;
 const fields=graph.views.map(v=>{
  const context=safeDiscord(`${v.sourceName} / ${v.projectName} · ${v.branchName}`,170);
  const body=[clipNative(v.warning,140),clipNative(v.actionable?'待你处理：'+v.question:v.blocker?'阻塞：'+v.blocker:v.summary||'来源尚未提供摘要',v.actionable?280:360),v.actionable?'请在原平台确认':'',v.actionable&&v.impact?clipNative('影响：'+v.impact,140):'',v.deadline?'请在 '+asTime(v.deadline)+' 前处理':'',v.phase?clipNative('当前：'+v.phase,80):'',clipNative(v.progress,80)].filter(Boolean).join('\n');
  return {name:safeDiscord(`${v.state.symbol} ${fitText(v.taskName,27)} / ${fitText(v.branchName,18)} · ${v.state.label}`,190),value:context+'\n'+utf16Limit(body,680)+'\n'+safeDiscord('来源更新 '+asTime(v.updatedAt),80),inline:false};
 });
 if(detail&&graph.views.length===1){const v=graph.views[0],b=v.branch;
  fields.push({name:'完整任务名称',value:safeDiscord(`${v.sourceName} / ${v.projectName} / ${v.taskName} / ${v.branchName}`,950),inline:false});
  if(v.actionable){let actionText=safeDiscord([v.question,v.impact?'影响：'+v.impact:'',v.deadline?'期限：'+asTime(v.deadline):'','请在原平台确认'].filter(Boolean).join('\n'),1800),part=1;while(actionText){const value=utf16Limit(actionText,950);fields.push({name:part===1?'完整待办内容':`待办内容（续 ${part}）`,value,inline:false});actionText=actionText.slice(value.length);part++;}}
  if(v.summary){let summary=safeDiscord(v.summary,2600),part=1;while(summary){const value=utf16Limit(summary,950);fields.push({name:part===1?'完整任务摘要':`任务摘要（续 ${part}）`,value,inline:false});summary=summary.slice(value.length);part++;}}
  const selected=snapshot.selection?.selected_node_id,node=selected?graph.nodes.find(n=>n.phase_id===selected||n.node_id===selected):undefined;
  if(node)fields.push({name:safeDiscord('历史阶段 · '+(node.label??'未命名阶段'),190),value:safeDiscord(`${node.summary??'该阶段未保存摘要'}\n阶段时间 ${asTime(node.occurred_at)}`,950),inline:false});
  const missing=[!v.phase?'阶段未提供':'',!v.progress?'未提供可核对数量':'',b.source_status==='needs_input'&&!v.actionable?'未确认存在当前有效的用户待办':''].filter(Boolean);if(missing.length)fields.push({name:'资料完整性',value:safeDiscord(missing.join('；'),400),inline:false});
 }
 let budget=5600;for(let i=0;i<fields.length;i++){const f=fields[i],size=f.name.length+f.value.length;if(size>budget){if(budget>f.name.length+30){f.value=utf16Limit(f.value,budget-f.name.length-20)+'\n内容较长，后续文字已截断';fields.splice(i+1);}else fields.splice(i);break;}budget-=size;}
 const c=graph.counts,counts=`${c.tasks} 个任务 · ${c.branches} 个分支`,attention=c.actionableTasks?`其中 ${c.actionableTasks} 个任务待你处理`:'';
 return {graph,payload:{content:`Rivule · ${counts}${attention?' · '+attention:''}`,allowed_mentions:mentionPolicy(),embeds:[{title:detail?'任务详情':'任务总览',description:[snapshot.test_only?'合成演示':'',graph.missingGlyphs?'部分字符请查看原生文字':''].filter(Boolean).join(' · ')||undefined,color:graph.views.length===1?Number.parseInt(graph.views[0].state.color.slice(1),16):0x6577A5,fields,footer:{text:`第 ${graph.page+1}/${graph.pages} 页 · 本页 ${graph.rows.length} 个分支`},image:{url:'attachment://progress.png'}}],attachments:[{id:'0',filename:'progress.png',description:`当前页的 PA、项目、任务与分支归属图。${counts}；本页 ${graph.rows.length} 个分支。状态与摘要见消息文字。`}],components:[]}};
}
export function buildEventMessage(dispatch:Dispatch):any {
 const p=dispatch.payload??{},event=p.event??{},sources:SourceView[]=p.sources??[],review=p.intent==='review';
 const v=displayBranch(event,{rendered_at:p.rendered_at??new Date().toISOString(),sources,request:p.intent==='request'?p.request:undefined,review});
 const request=p.intent==='request',requestState=p.request?.state;
 const label=review?'状态待核对':request&&requestState==='expired'?'请求已过期':request&&['changed','resolved_by_source'].includes(requestState)?'请求已更新':v.state.label;
 const title=`${safeDiscord(v.projectName,48)} · ${safeDiscord(v.taskName,90)} / ${safeDiscord(v.branchName,60)}｜${label}`;
 const main=review?v.summary||'收到一条待核对的更新':v.actionable?v.question:v.blocker?'阻塞：'+v.blocker:v.summary||'来源尚未提供摘要';
 const description=[main,v.actionable&&v.impact?'影响：'+v.impact:'',v.deadline?'请在 '+asTime(v.deadline)+' 前处理':'',v.warning,requestState==='resolved_by_source'?'原任务已不再等待此请求':'',requestState==='changed'?'请求内容已变化，请回原平台核对':'',request?(v.actionable?'请在原平台确认；打开原任务不等于批准':'请求现状以原平台为准；打开原任务不等于批准'):'',v.phase&&!request?'当前：'+v.phase:'',v.progress&&!request?v.progress:'',`分支：${v.branchName}`,`来源：${v.sourceName} · ${asTime(v.updatedAt)}`].filter(Boolean).join('\n');
 return {content:safeDiscord(`${v.taskName}：${main}${p.test_only?'（合成演示）':''}`,240),allowed_mentions:mentionPolicy(),embeds:[{title,description:safeDiscord(description,3500),color:Number.parseInt((review?'#875914':v.state.color).slice(1),16)}],components:p.test_only===true?[]:originalButton(event,sources,v.actionable?'去原任务确认':'打开原任务'),attachments:[]};
}
export function createMessagePreparer(renderer:PngRenderer,options:{scale?:1|2;utcOffsetMinutes?:number}={}) {return async(dispatch:Dispatch):Promise<{payload:any;png?:Uint8Array}>=>{if(dispatch.payload?.intent!=='overview')return {payload:buildEventMessage(dispatch)};const snapshot=snapshotFromDispatch(dispatch);const {payload,graph}=buildOverviewMessage({...snapshot,utc_offset_minutes:options.utcOffsetMinutes??snapshot.utc_offset_minutes});payload.components=dispatch.payload.components??[];
 if(snapshot.selection?.branch_key&&graph.rows.length===1&&!snapshot.test_only&&payload.components.length<5){const link=originalButton(graph.rows[0],graph.sources);if(link.length)payload.components=[...payload.components,...link];}
 return {payload,png:await renderer(graph,options.scale??2)};};}
