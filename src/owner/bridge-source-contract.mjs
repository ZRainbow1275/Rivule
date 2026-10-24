import {BridgeError, BRIDGE_CONTEXT_FIELDS} from './message-bridge.mjs';
export const bridgeActions=['capabilities','register_context','publish_response','response_receipt','claim','acknowledge'];
export async function bridgeSourceOperation(bridge,source,action,args){
  if(!bridgeActions.includes(action)||!args||Array.isArray(args)||typeof args!=='object')throw new BridgeError('invalid_bridge_operation');
  if(action==='capabilities'){if(Object.keys(args).length)throw new BridgeError('invalid_bridge_operation');return bridge.capabilities(source);}
  if(action==='register_context')return bridge.registerContext(source,args);
  if(action==='publish_response')return bridge.publishResponse(source,args);
  if(action==='claim')return bridge.claim(source,args);
  if(action==='acknowledge')return bridge.acknowledge(source,args);
  if(Object.keys(args).join(',')!=='receipt_id'||typeof args.receipt_id!=='string')throw new BridgeError('invalid_bridge_operation');
  return bridge.responseReceipt(source,args.receipt_id);
}
const identifier={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'};
const context=Object.fromEntries(BRIDGE_CONTEXT_FIELDS.map(k=>[k,identifier]));
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const definitions=[
 ['capabilities','Read this PA bridge preference and supported transport. No global interception or wake capability.',schema({}),true],
 ['register_context','Register the exact real task and source conversation/thread for subsequent relay. No synthetic task IDs or discovery.',schema(context),false],
 ['publish_response','Relay explicitly selected user-visible text from this PA in an existing registered task context. Requires owner every_response opt-in. Never forward received relay echoes, reasoning, secrets, or raw tool traffic.',schema({...context,response_id:identifier,text:{type:'string',minLength:1,maxLength:1200},content_kind:{const:'user_visible_response'},origin:{const:'source'}}),false],
 ['response_receipt','Read provider acceptance separately from recipient confirmation for this PA response.',schema({receipt_id:{type:'string'}}),true],
 ['claim','Claim at most one owner command for an exact registered task/thread. Owner commands opt-in required. A duplicate claim must never execute; lost claims become unknown, not reissued. Apply source policy before any execution.',schema({...context,claim_id:identifier}),false],
 ['acknowledge','Record source-reported completion, rejection, or unknown command outcome with the exact claim token. Not independently verified execution.',schema({command_id:{type:'string'},claim_token:{type:'string'},outcome:{enum:['completed','rejected','unknown']}}),false]
];
export const bridgeTools=definitions.map(([action,description,inputSchema,read])=>({name:'bridge_'+action,description,inputSchema,annotations:{readOnlyHint:read,destructiveHint:false,idempotentHint:true,openWorldHint:!read},securitySchemes:[{type:'oauth2',scopes:[read?'pa:receipt':'pa:publish']}],_meta:{securitySchemes:[{type:'oauth2',scopes:[read?'pa:receipt':'pa:publish']}]}}));
