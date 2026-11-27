import fs from 'node:fs';import {validateCatalog,gateRoute} from './capability-gates.mjs';
const base=JSON.parse(fs.readFileSync(new URL('./market-foundation.json',import.meta.url)));
const ids=new Map([['meta-muse','muse-personal'],['glean','glean-durable'],['lindy','lindy-personal'],['cn-doubao-xiaodou','doubao-xiaodou'],['cn-ant-lingguang','lingguang'],['cn-baidu-dumate','baidu-dumate-managed'],['cn-qwenwork','qwenwork'],['cn-workbuddy-client','workbuddy'],['cn-workbuddy-managed','workbuddy-managed'],['cn-yuanbao','yuanbao'],['cn-coze-published','coze-cn'],['cn-feishu-aily','feishu-aily'],['cn-qwenpaw','qwenpaw'],['cn-youdao-lobster','lobster-ai'],['cn-baidu-agentbuilder-sunset','wenxin-agentbuilder']]);
const kindType={work_assistant:'consumer',personal_assistant:'consumer',workspace_agent:'enterprise',self_hosted:'self-hosted',specialist_coding:'platform',device_assistant:'consumer',vertical_assistant:'consumer',workflow_platform:'platform',published_app:'platform',self_hosted_pa:'self-hosted',personal_pa:'consumer',professional_pa:'enterprise',retired:'platform',sunset:'platform'};
const types={dispatch_mcp:'push',dispatch_api:'push',self_host_dispatch:'push',routine_trigger:'push',inbound_only:'push',
 reverse_connector:'pull',reverse_candidate:'pull',pull_candidate:'pull',pull_review:'pull',manual_handoff:'handoff',tool_gateway:'observe',unverified:'observe',preview:'observe',push_app:'push',push_host:'push',pull_mcp:'pull',retired:'observe',sunset:'observe',handoff:'handoff',connector_read:'read',data_connector:'observe',dispatch_reply:'observe',device_extension:'handoff',policy_held:'observe',unavailable:'observe',local_candidate:'observe',push_cli:'push',external_runtime:'handoff',published_capability:'observe',vertical_only:'observe',watch:'observe'};
const makeRoute=(mode,stage)=>({mode,stage,effect:mode==='read'?'read-status':['handoff','observe'].includes(mode)?'manual-copy':'research-public-text',liveTested:false});
const evidenceLabel={dispatch_mcp:'MCP 工具派工',dispatch_api:'API 派工',push_app:'托管应用开放接口',push_host:'自托管入口',push_cli:'官方 CLI（需独立本地执行器）',routine_trigger:'仅触发已配置流程，需另验结果',inbound_only:'仅收消息，需另验结果',pull_candidate:'MCP 领单候选',pull_review:'需官方审核或上架',data_connector:'仅数据连接',dispatch_reply:'仅文本回复',device_extension:'设备能力扩展',unavailable:'已退场或尚未上线',sunset:'已公告即将停服'};
const xtrim=s=>typeof s==='string'?s.trim().slice(0,245):null;
const rows=new Map(base.map(r=>[r.id,r]));
for(const spec of process.argv.slice(2)){
 const [market,...p]=spec.split(':');const file=p.join(':');
 const input=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const item of input.records??input.providers??input.entries??[]){
  const id=ids.get(item.id)||item.id;if(!id||!(item.name??item.product)||!Array.isArray(item.sources)||!item.sources.length)throw Error('incomplete provider '+id);
  const type=kindType[item.product_kind??item.surface]??'platform',route=types[item.route]??'observe';
  const stage=item.route==='retired'?'retired':item.route==='sunset'?'documented':route==='observe'||['reverse_candidate','pull_candidate','pull_review'].includes(item.route)?'unverified':'documented';
  const converted={id,name:item.name??item.product,type,market,reviewed:'2026-11-27',routes:[makeRoute(route,stage)],
   official:item.sources,limits:[xtrim(item.verified_contract_zh??item.protocol),xtrim(item.activation_gate_zh??item.eligibility),xtrim(item.market_or_residency??item.boundary),xtrim(item.documented_market),evidenceLabel[item.route]].filter(Boolean)};
  const current=rows.get(id);
  if(current){
   current.official=[...new Set([...current.official,...converted.official])];
   current.limits=[...new Set([...current.limits,...converted.limits])];
   if(current.routes.every(x=>x.mode==='observe')&&converted.routes[0].stage==='documented'&&converted.routes[0].mode!=='observe')current.routes=converted.routes;
  }else rows.set(id,converted);
 }
}
const matrix=[...rows.values()].sort((a,b)=>a.market.localeCompare(b.market)||a.name.localeCompare(b.name,'zh-CN'));
const view=validateCatalog(matrix);
const status={};
for(const x of view.values())for(const r of x.routes){
 const key=gateRoute({row:x,mode:r.mode}).state;
 status[key]=(status[key]??0)+1;
}
fs.writeFileSync(new URL('./market-merged.json',import.meta.url),JSON.stringify(matrix,null,2)+'\n');
console.log(JSON.stringify({products:matrix.length,coverage:status},null,2));
