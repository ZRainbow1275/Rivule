import test from 'node:test';
import A from 'node:assert/strict';
import {fixture,replay,sample,sameNameChanged} from '../examples/acceptance-demo.mjs';
import {compareArtifactBytes,makeSyntheticAcceptance} from '../src/sdk/portable-acceptance.mjs';

test('an accepted sample round-trips, but editing same-name bytes or using only provider completion does not prove acceptance',()=>{
 const x=replay();A.deepEqual(x.cases,[
  {case:'original',fileOnly:'artifact_matches_unverified_record',ledger:'acceptance_verified_in_ledger'},
  {case:'same_name_changed',fileOnly:'artifact_mismatch',ledger:null},
  {case:'provider_complete_only',fileOnly:null,ledger:'delivered_only'}]);
 const checked=JSON.stringify(x);
 for(const field of ['demo-private-ledger','demo-internal-task','fixture-provider','lead-internal-fixture','worker-internal-fixture','ffffffffffffffff','瓦尔帕莱索'])A(!checked.includes(field));
 A.throws(()=>makeSyntheticAcceptance(),/explicit synthetic/);
 if(process.env.RIVULE_ACCEPTANCE_SAMPLE==='1')console.log('RIVULE_ACCEPTANCE_SAMPLE:'+checked);
});

test('historical export requires current coordinator read authority and exact acceptance revision',()=>{
 const f=fixture(),arg={...f.select,atVersion:f.accepted};
 A.throws(()=>f.proof.exportRecord(f.journal,{...arg,readable:[]}),{code:'not_authorized'});
 A.throws(()=>f.proof.exportRecord(f.journal,{...arg,auth:{...arg.auth,role:'worker'}}),{code:'not_authorized'});
 A.throws(()=>f.proof.exportRecord(f.journal,{...arg,atVersion:f.delivered}),{code:'no_acceptance_at_revision'});
 A.throws(()=>f.proof.exportRecord(f.journal,{...arg,atVersion:f.accepted+1}),{code:'revision_conflict'});
 const forged=structuredClone(f.journal);
 forged.events[f.accepted-1].command.artifact='2'.repeat(64);
 A.throws(()=>f.proof.exportRecord(forged,arg),{code:'artifact_mismatch'});
});

test('a matching hash alone cannot authenticate modified metadata or grant access',()=>{
 const f=fixture(),record=f.proof.exportRecord(f.journal,{...f.select,atVersion:f.accepted});
 const changed={...record,attemptAlias:'wrong-attempt'};
 A.equal(compareArtifactBytes(changed,sample),'artifact_matches_unverified_record');
 A.equal(f.proof.verifyTrustedCopy(changed,sample,f.journal,f.select),'record_mismatch');
 A.equal(f.proof.verifyTrustedCopy(record,sameNameChanged,f.journal,f.select),'artifact_mismatch');
 A.throws(()=>f.proof.verifyTrustedCopy(record,sample,f.journal,{...f.select,readable:[]}),{code:'not_authorized'});
 A.throws(()=>compareArtifactBytes({...record,receipt:'oops'},sample),/invalid acceptance copy/);
 A.throws(()=>compareArtifactBytes(record,sample.toString('utf8')),/raw artifact bytes/);
});
