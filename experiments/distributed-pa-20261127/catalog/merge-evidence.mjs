import fs from 'node:fs';import {validateCatalog,gateRoute} from './capability-gates.mjs';
const base=JSON.parse(fs.readFileSync(new URL('./market-foundation.json',import.meta.url)));
const ids=new Map([['meta-muse','muse-personal'],['glean','glean-durable'],['lindy','lindy-personal'],['cn-feishu-aily','feishu-aily'],['cn-qwenpaw','qwenpaw'],['cn-youdao-lobster','lobster-ai'],['cn-baidu-agentbuilder-sunset','wenxin-agentbuilder']]);
const kindType={work_assistant:'consumer',personal_assistant:'consumer',workspace_agent:'enterprise',self_hosted:'self-hosted',specialist_coding:'platform',workflow_platform:'platform',published_app:'platform',self_hosted_pa:'self-hosted',personal_pa:'consumer',professional_pa:'enterprise',retired:'platform',sunset:'platform'};
const types={dispatch_mcp:'push',dispatch_api:'push',self_host_dispatch:'push',routine_trigger:'push',inbound_only:'push',
 reverse_connector:'pull',reverse_candidate:'pull',manual_handoff:'handoff',tool_gateway:'observe',unverified:'observe',preview:'observe',push_app:'push',push_host:'push',pull_mcp:'pull',retired:'observe',sunset:'observe',handoff:'handoff',connector_read:'read'};
const makeRoute=(mode,stage)=>({mode,stage,effect:mode==='read'?'read-status':['handoff','observe'].includes(mode)?'manual-copy':'research-public-text',liveTested:false});
const xtrim=s=>typeof s==='string'?s.trim().slice(0,245):null;
const rows=new Map(base.map(r=>[r.id,r]));
for(const spec of process.argv.slice(2)){
 const [market,...p]=spec.split(':');const file=p.join(':');
 const input=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const item of input.records??input.providers??input.entries??[]){
  const id=ids.get(item.id)||item.id;if(!id||!(item.name??item.product)||!Array.isArray(item.sources)||!item.sources.length)throw Error('incomplete provider '+id);
  const type=kindType[item.product_kind??item.surface]??'platform',route=types[item.route]??'observe';
  const stage=item.route==='retired'?'retired':item.route==='sunset'?'documented':route==='observe'||item.route==='reverse_candidate'?'unverified':'documented';
  const converted={id,name:item.name??item.product,type,market,reviewed:'2026-11-27',routes:[makeRoute(route,stage)],
   official:item.sources,limits:[xtrim(item.verified_contract_zh??item.protocol),xtrim(item.activation_gate_zh??item.eligibility),xtrim(item.market_or_residency??item.boundary)].filter(Boolean)};
  const current=rows.get(id);
  if(current){
   current.official=[...new Set([...current.official,...converted.official])];
   current.limits=[...new Set([...current.limits,...converted.limits])];
   if(current.routes.every(x=>x.mode==='observe')&&converted.routes[0].stage==='documented')current.routes=converted.routes;
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
