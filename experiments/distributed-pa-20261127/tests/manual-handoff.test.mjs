import test from 'node:test';import A from 'node:assert/strict';import {createHash} from 'node:crypto';
import {buildManualBrief,prepareManualCandidate} from '../adapter/manual-handoff.mjs';
const text='Compare dates from public release notes.',inputDigest=createHash('sha256').update(text).digest('hex');
const authorization={board:'secret-board-key',task:'internal-task-6',subject:'private-seat',channel:'xiaodou',effect:'manual-copy',classification:'public-text',explicitCopyAllowed:true,inputDigest};
test('manual fallback never leaks opaque board markers and never dispatches',async()=>{
 const b=await buildManualBrief({authorization,route:'xiaodou',text});
 A.equal(b.status,'awaiting_user_copy');
 A(!b.draft.includes(authorization.board)&&!b.draft.includes(authorization.task)&&!b.draft.includes(authorization.subject));
 await A.rejects(buildManualBrief({authorization,route:'other',text}),/explicit/);
});
test('changed brief and unauthorized nonpublic text fail before copy',async()=>{
 await A.rejects(buildManualBrief({authorization,route:'xiaodou',text:'different'}),/changed/);
 await A.rejects(buildManualBrief({authorization:{...authorization,classification:'team-private'},route:'xiaodou',text}),/public/);
});
test('manual result is not provider evidence, terminal status or automatic acceptance',async()=>{
 const {proof}=await buildManualBrief({authorization,route:'xiaodou',text});
 const a={...authorization,effect:'manual-return',explicitImportAllowed:true,exportDigest:proof.exportDigest};
 const r=await prepareManualCandidate({authorization:a,route:'xiaodou',briefProof:proof,result:'candidate report',provenance:'user_pasted_unverified'});
 A.equal(r.status,'manual_candidate_for_owner_review');A.equal(r.providerEvidence,false);A.equal(r.accepted,false);
 await A.rejects(prepareManualCandidate({authorization:{...a,exportDigest:'a'.repeat(64)},route:'xiaodou',briefProof:proof,result:'candidate report',provenance:'user_pasted_unverified'}),/out-of-scope/);
});
