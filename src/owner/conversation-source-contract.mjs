import {BridgeError} from './message-bridge.mjs';
import {CONVERSATION_OPERATIONS} from './conversation-bridge.mjs';
export const conversationActions=['capabilities',...CONVERSATION_OPERATIONS];
export const conversationScope=action=>['capabilities','response_receipt'].includes(action)?'pa:conversation:read':['claim','acknowledge'].includes(action)?'pa:conversation:commands':'pa:conversation:publish';
export async function conversationSourceOperation(bridge,source,action,args){
 if(!conversationActions.includes(action)||!args||typeof args!=='object'||Array.isArray(args))throw new BridgeError('invalid_conversation_operation');
 if(action==='capabilities'){if(Object.keys(args).length)throw new BridgeError('invalid_conversation_operation');return bridge.capabilities(source);}
 if(action==='response_receipt'){if(Object.keys(args).join(',')!=='receipt_id')throw new BridgeError('invalid_conversation_operation');return bridge.responseReceipt(source,args.receipt_id);}
 return bridge[{register_context:'registerContext',publish_response:'publishResponse',claim:'claim',acknowledge:'acknowledge'}[action]](source,args);
}
const id={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'},uuid={type:'string',format:'uuid'},schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const definitions={capabilities:{},register_context:{kind:{const:'conversation'},version:{const:2},conversation_id:id,thread_id:id},publish_response:{context_ref:uuid,response_id:id,text:{type:'string',minLength:1,maxLength:1200,description:'At most 1200 UTF-16 code units (emoji may use two or more); plain user-visible text only. Oversize or malformed Unicode is rejected, never truncated or split.'},content_kind:{const:'user_visible_response'},origin:{const:'source'},sensitivity:{const:'normal'},reviewed:{const:true}},response_receipt:{receipt_id:uuid},claim:{context_ref:uuid,claim_id:id},acknowledge:{command_id:{type:'string'},claim_token:uuid,outcome:{enum:['completed','rejected','unknown']}}};
export const conversationTools=conversationActions.map(action=>({name:'bridge_conversation_'+action,description:'Explicit version-2 ordinary conversation bridge. Separate source operation authority and owner channel/category consent required; task grants do not apply. Publishing may send real external channel notifications; accepted does not mean delivered. Source assertions are not independent provider ownership proof. Forward only reviewed normal user-visible final text, never reasoning, tool traffic, secrets, restricted content or relay echoes. Claim is not execution approval and cannot wake a PA.',inputSchema:schema(definitions[action]),annotations:{readOnlyHint:['capabilities','response_receipt'].includes(action),destructiveHint:false,idempotentHint:true,openWorldHint:action==='publish_response'},securitySchemes:[{type:'oauth2',scopes:[conversationScope(action)]}],_meta:{securitySchemes:[{type:'oauth2',scopes:[conversationScope(action)]}]}}));
// Deployment-time authority is deliberately absent by default. It is NOT inferred
// from an existing task credential, source mode, owner relay consent or request.
export function configuredConversationGrant(raw,source,proof){
 if(!raw)return null;let list;try{list=JSON.parse(raw);}catch{return null;}
 if(!Array.isArray(list)||list.length>16)return null;
 const fields=['source_id','provider_id','account_binding','generation','revision','operations','enabled'];
 if(list.some(v=>!v||Object.keys(v).length!==fields.length||!fields.every(k=>Object.hasOwn(v,k))))return null;
 const matches=list.filter(v=>v.source_id===source.source_id);if(matches.length!==1)return null;
 const g=matches[0];if(!proof?.selectable||g.generation!==proof.generation||g.provider_id!==source.provider)return null;
 return g;
}
