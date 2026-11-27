// Authorization-first discovery seam. No callTool, OAuth login, or network.
const partnerEndpoints=Object.freeze({tasklet:'https://api.tasklet.ai/mcp'});
const name=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(x);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const ownObject=x=>x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
function canonicalSchema(value){
 let remaining=2000;
 const seen=new WeakSet();
 function visit(x,depth){
  if(--remaining<0||depth>20)throw new TypeError('schema limit');
  if(x===null||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return x;
  if(typeof x==='string'&&x.length<=4096)return x;
  if((!Array.isArray(x)&&!ownObject(x))||seen.has(x))throw new TypeError('non-JSON schema');
  seen.add(x);
  if(Array.isArray(x))return x.map(y=>visit(y,depth+1));
  return Object.fromEntries(Object.keys(x).sort().map(k=>[k,visit(x[k],depth+1)]));
 }
 return JSON.stringify(visit(value,0));
}
export async function reviewMcpPeer({provider,verified,allowedAgentRefs,toolList,approvedFingerprints}){
 if(!Object.hasOwn(partnerEndpoints,provider)||verified?.origin!==partnerEndpoints[provider]||
    verified?.oauthUserScope!==true||!name(verified?.subject)||
    !Array.isArray(allowedAgentRefs)||allowedAgentRefs.length<1||allowedAgentRefs.length>32||!allowedAgentRefs.every(name)||
    new Set(allowedAgentRefs).size!==allowedAgentRefs.length)
  return {state:'needs_user_binding',tools:[]};
 if(!Array.isArray(toolList)||toolList.length>64||!toolList.every(t=>name(t?.name)&&t.inputSchema?.type==='object'))
  return {state:'needs_schema_review',tools:[]};
 const approved=approvedFingerprints instanceof Map?approvedFingerprints:new Map();
 const tools=[],seen=new Set(), scope=['mcp-peer-v2',provider,verified.origin,verified.subject,[...allowedAgentRefs].sort()];
 for(const t of toolList){
  if(seen.has(t.name))return {state:'needs_schema_review',tools:[]};seen.add(t.name);
  let schema;try{schema=canonicalSchema(t.inputSchema);}catch{return {state:'needs_schema_review',tools:[]};}
  if(schema.length>16000)return {state:'needs_schema_review',tools:[]};
  const fingerprint=await sha(JSON.stringify([scope,t.name,schema]));
  // Descriptions and annotations are not instructions or authorization. Only
  // a previously reviewed fingerprint + semantics can enter the allowlist.
  const letter=approved.get(t.name);
  const passed=letter?.fingerprint===fingerprint&&['public_task','read_status'].includes(letter?.semantic);
  tools.push({name:t.name,fingerprint,status:passed?'known':'needs_review',...(passed?{semantic:letter.semantic}:{})});
 }
 return {state:tools.some(x=>x.status==='known')?'verified_schema_offline':'needs_schema_review',tools};
}
