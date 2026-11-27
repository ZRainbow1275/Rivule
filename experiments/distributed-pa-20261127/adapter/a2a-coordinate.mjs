// A2A 1.0.1 isolated dispatch experiment. A server chooses a fixed binding and
// injects a trusted transport; task text cannot choose an endpoint or account.
const id=s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(s);
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const lead='a2a';
export async function dispatchA2A({commit,sendMessage,binding,task,fence,text,clock}){
 if(typeof commit!=='function'||typeof clock!=='function'||typeof sendMessage!=='function'||
 !id(task)||!Number.isSafeInteger(fence)||fence<=0||
 typeof text!=='string'||!text.trim()||text.length>3000||
 binding?.approvedClass!=='public-text'||binding?.provider!==lead||
 binding?.contract!=='1.0.1'||!id(binding.lane)||!id(binding.endpointRef)||!/^[a-f0-9]{64}$/.test(binding.inputDigest))
  throw new TypeError('not a reviewed public A2A binding');
 const digest=await hash(text);
 if(digest!==binding.inputDigest)throw new TypeError('input digest mismatch');
 const eventKey=await hash(JSON.stringify([task,fence]));
 const x=await commit({type:'begin',id:'a2a-begin-'+eventKey,task,fence});
 const p=x?.permit;
 if(!x?.committed||!p)return {state:'no_fresh_permit'};
 let taskId=null, sent=false;
 try{
  if(p.task!==task||p.fence!==fence||p.provider!==lead||p.lane!==binding.lane||
     p.inputDigest!==digest||typeof p.key!=='string'||clock()>=p.expiresAt)throw Error('bound permit mismatch');
  const messageId='rivule-'+await hash(p.key);
  if(clock()>=p.expiresAt)throw Error('permit expired before dispatch');
  sent=true;
  const response=await sendMessage({endpointRef:binding.endpointRef,version:'1.0.1',
   request:{message:{messageId,role:'ROLE_USER',parts:[{text}]},configuration:{historyLength:4,acceptedOutputModes:['text/plain']}}});
  // A2A also permits a direct Message. This adapter only auto-acknowledges
  // correlated task evidence; untyped/synchronous output goes to original-attempt review.
  const t=response?.task;
  const echoed=m=>m?.messageId===messageId&&m?.role==='ROLE_USER'&&Array.isArray(m.parts)&&m.parts.length===1&&m.parts[0]?.text===text;
  if(t&&id(t.id)&&id(t.contextId)&&(echoed(t.status?.message)||Array.isArray(t.history)&&t.history.length<=4&&t.history.some(echoed)))
   taskId=t.id;
 }catch{/* The server may already have created work. No automatic retry. */}
 try{
  const r=await commit({type:taskId?'acknowledged':'uncertain',id:'a2a-observe-'+eventKey,task,fence,...(taskId?{receipt:taskId}:{})});
  return {state:r?.committed?(taskId?'provider_acknowledged':'verify_original_attempt'):'verify_original_attempt',sent};
 }catch{return {state:'verify_original_attempt',sent};}
}
// This assistant can discover protocol capabilities or read a known task;
// only a trusted adapter supplies original exact attempt evidence to the ledger.
export function assumeRemoteClosedFromList(){return false;}
