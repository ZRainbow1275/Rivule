import {readFileSync} from 'node:fs';
import resvg from '../../local-candidate/cloudflare/node_modules/@resvg/resvg-wasm/index.js';
import {safeUrl} from './worker.node.mjs';
const root=new URL('../',import.meta.url),patch=readFileSync(new URL('display-only.patch.js',root),'utf8');
class Core {controls(){return []}}
export const display=new Function('initWasm','Resvg2','safeUrl','OwnerCore','var createMessagePreparer,createPngRenderer;'+patch+';return __rivuleDisplay;')(resvg.initWasm,resvg.Resvg,safeUrl,Core);
export const renderer=display.createPngRenderer({wasmModule:readFileSync(new URL('modules/dd4dd8881e2df4e64203b5c0ae65e1648ab55207-index_bg.wasm',root)),fontBuffers:[readFileSync(new URL('modules/9afe5fb649a734453ec6387663c37094ca1e46a9-NotoSansCJKSC-Regular.otf',root))]});
export const now='2026-10-18T17:20:00.000Z';
export const sources=[{source_id:'zot-main',display_name:'Zot',provider:'dot',enabled:true,selectable:true,connection_status:'verified',verification_status:'verified'},{source_id:'spark-main',display_name:'Gemini Spark',provider:'spark',enabled:true,selectable:true,connection_status:'verified',verification_status:'verified'},{source_id:'muse-main',display_name:'Muse',provider:'muse',enabled:true,selectable:true,connection_status:'verified',verification_status:'verified'}];
export function branch(change={}){const b={source_id:'zot-main',project_id:'rivule',project_name:'Rivule',task_id:'readability',task_name:'通知可读性',run_id:'synthetic-run',branch_id:'copy',branch_name:'文案分支',source_status:'running',summary:'已整理 3 种通知模板',occurred_at:'2026-10-18T17:18:00.000Z',last_confirmed_at:'2026-10-18T17:18:00.000Z',source_url:'https://example.com/synthetic-task',stale:false,...change};b.branch_key=JSON.stringify([b.source_id,b.task_id,b.run_id,b.branch_id]);return b;}
export const action={request_id:'synthetic-review',question:'是否发布这版通知模板？',impact:'会替换现有通知模板',expires_at:null,mode:'return_to_source'};
export function evidence(b,state='pending'){return {request_key:JSON.stringify([b.branch_key,b.action.request_id]),branch_key:b.branch_key,request_id:b.action.request_id,state,version:7};}
export function snapshot(bs,requests=[]){return {branches:bs,requests,sources,rendered_at:now,utc_offset_minutes:480,test_only:true,revision:7};}
const pending=branch({source_status:'needs_input',summary:'通知模板已准备好，等待发布确认',action}),expired=branch({source_status:'needs_input',action:{...action,expires_at:'2026-10-18T17:00:00Z'}});
export const fixtures=[
 {id:'01-running',name:'进行中',snapshot:snapshot([branch()]),event:branch()},
 {id:'02-completed',name:'分支完成',snapshot:snapshot([branch({source_status:'completed',summary:'文案分支已完成，3 种模板可供检查'})]),event:branch({source_status:'completed',summary:'文案分支已完成，3 种模板可供检查'})},
 {id:'03-blocked',name:'受阻',snapshot:snapshot([branch({task_id:'qq-receipt',task_name:'QQ 回执',branch_name:'送达验证',blocker:'暂未拿到回执，尚不能确认送达',summary:'已发出测试通知，等待回执证据'})]),event:branch({task_id:'qq-receipt',task_name:'QQ 回执',branch_name:'送达验证',blocker:'暂未拿到回执，尚不能确认送达'})},
 {id:'04-owner-request',name:'用户请求',snapshot:snapshot([pending],[evidence(pending)]),event:pending,request:evidence(pending),intent:'request'},
 {id:'05-expired-request',name:'已过期请求',snapshot:snapshot([expired],[evidence(expired)]),event:expired,request:evidence(expired),intent:'request'},
 {id:'06-no-summary',name:'无摘要',snapshot:snapshot([branch({summary:''})]),event:branch({summary:''})},
 {id:'07-state-conflict',name:'状态冲突',snapshot:snapshot([branch({task_name:'发布验证',summary:'最后确认仍在验证；冲突更新尚未覆盖记录'})]),event:branch({task_name:'发布验证',source_status:'completed',summary:'收到一条完成更新，但与已知顺序冲突'}),intent:'review'},
 {id:'08-multi-pa-same-name',name:'多 PA 同名任务',snapshot:snapshot([branch(),branch({source_id:'spark-main',branch_name:'研究分支',summary:'已比较 3 种手机端信息布局'}),branch({source_id:'muse-main',project_id:'game',project_name:'地牢游戏',branch_name:'视觉分支',summary:'已整理通知图标与中文标签'})]),event:branch()}
];
export function controlsFor(s){const options=[{label:'全部路线',value:'all'},...s.branches.slice(0,3).map((b,i)=>({label:b.task_name+' · '+b.branch_name,value:'route'+i}))];const controls=[{type:1,components:[{type:3,custom_id:'view:source-ref',placeholder:'选择 PA 来源',min_values:1,max_values:1,options:[{label:'全部来源',value:'all'},...sources.map(s=>({label:s.display_name,value:s.source_id}))]}]},{type:1,components:[{type:3,custom_id:'view:route-ref',placeholder:'选择当前页路线详情',min_values:1,max_values:1,options}]},{type:1,components:[{type:2,style:2,label:'上一组',custom_id:'view:previous',disabled:true},{type:2,style:2,label:'下一组',custom_id:'view:next',disabled:true},{type:2,style:2,label:'连接管理',custom_id:'view:connections'},{type:2,style:2,label:'QQ 设置',custom_id:'qqsetup:open'}]}];
 const entries=s.branches.slice(0,3).map((b,i)=>({value:'route'+i,branch_key:b.branch_key}));const core={snapshot:()=>s,selection:()=>s.selection??{},clock:()=>Date.parse(s.rendered_at),canNotify:()=>true,one:(sql,ref)=>({payload:JSON.stringify(entries)})};return display.decorateControls(core,controls,s.revision);}
