// Authorization-first discovery seam. No callTool, OAuth login, or network.
const partnerEndpoints=Object.freeze({tasklet:'https://api.tasklet.ai/mcp'});
const name=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(x);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const normalize=x=>Array.isArray(x)?x.map(normalize):x&&typeof x==='object'
 ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])])):x;
export async function reviewMcpPeer({provider,verified,allowedAgentRefs,toolList,approvedFingerprints}){
 if(!Object.hasOwn(partnerEndpoints,provider)||verified?.origin!==partnerEndpoints[provider]||
    verified?.oauthUserScope!==true||!name(verified?.subject)||
    !Array.isArray(allowedAgentRefs)||allowedAgentRefs.length<1||!allowedAgentRefs.every(name))
  return {state:'needs_user_binding',tools:[]};
 if(!Array.isArray(toolList)||toolList.length>64||!toolList.every(t=>name(t?.name)&&t.inputSchema?.type==='object'))
  return {state:'needs_schema_review',tools:[]};
 const approved=approvedFingerprints instanceof Map?approvedFingerprints:new Map();
 const tools=[],seen=new Set();
 for(const t of toolList){
  if(seen.has(t.name))return {state:'needs_schema_review',tools:[]};seen.add(t.name);
  const schema=JSON.stringify(normalize(t.inputSchema));if(schema.length>16000)return {state:'needs_schema_review',tools:[]};
  const fingerprint=await sha(JSON.stringify([provider,t.name,schema]));
  // Descriptions and annotations are not instructions or authorization. Only
  // a previously reviewed fingerprint + semantics can enter the allowlist.
  const letter=approved.get(t.name);
  const passed=letter?.fingerprint===fingerprint&&['public_task','read_status'].includes(letter?.semantic);
  tools.push({name:t.name,fingerprint,status:passed?'known':'needs_review',...(passed?{semantic:letter.semantic}:{})});
 }
 return {state:tools.some(x=>x.status==='known')?'verified_schema_offline':'needs_schema_review',tools};
}
