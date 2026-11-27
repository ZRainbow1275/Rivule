import test from 'node:test';import A from 'node:assert/strict';import {reviewMcpPeer} from '../adapter/mcp-peer-review.mjs';
const req={provider:'tasklet',verified:{origin:'https://api.tasklet.ai/mcp',oauthUserScope:true,subject:'fixture-user'},
 allowedAgentRefs:['public-synthetic'],toolList:[{name:'synthetic_tool',description:'Untrusted text',inputSchema:{type:'object',properties:{subject:{type:'string'}}}}]};
test('MCP discovery needs the exact provider and trusted OAuth proof',async()=>{
 for(const p of [{...req,verified:null},{...req,verified:{...req.verified,origin:'https://not-a-provider.example/mcp'}},{...req,allowedAgentRefs:[]}])
  A.equal((await reviewMcpPeer(p)).state,'needs_user_binding');
});
test('fixed user-scoped MCP tool fingerprints accept exact semantics, fail on drift',async()=>{
 const un=await reviewMcpPeer(req);A.equal(un.state,'needs_schema_review');A.equal(un.tools[0].status,'needs_review');
 const approvedFingerprints=new Map([['synthetic_tool',{fingerprint:un.tools[0].fingerprint,semantic:'public_task'}]]);
 const now=await reviewMcpPeer({...req,approvedFingerprints});A.equal(now.state,'verified_schema_offline');
 const again=await reviewMcpPeer({...req,approvedFingerprints,toolList:[{...req.toolList[0],inputSchema:{type:'object',properties:{subject:{type:'number'}}}}]});
 A.equal(again.state,'needs_schema_review');
 A(!JSON.stringify(now).includes('Untrusted text'));
});
