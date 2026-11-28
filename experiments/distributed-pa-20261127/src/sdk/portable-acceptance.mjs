// Opt-in offline laboratory only. This is not a signature or a provider
// receipt. The exported copy exposes no real board, users, lanes or inputs.
import {createHash} from 'node:crypto';
import {acceptanceFacts,BoardConflict} from './coordination-board.mjs';

const marker='rivule.synthetic-acceptance/1', issuer='coordinator';
const alias=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const facts=['schema','synthetic','taskAlias','attemptAlias','acceptedByRole','acceptedAt','acceptanceVersion','artifactSha256'];
export function makeSyntheticAcceptance({enabled=false,aliases}={}){
 if(!enabled||typeof aliases!=='function')throw new TypeError('explicit synthetic acceptance fixture required');
 function exportRecord(journal,selection){
  const {task,atVersion}=selection;
  const verified=acceptanceFacts(journal,selection);
  // Explicit fixture alias mapping; never default to the original task, scope,
  // reviewer, receipt, or provider identity. No result from a client request.
  const a=aliases({scope:journal.scope,task,fence:verified.fence});
  if(!alias(a?.taskAlias)||!alias(a.attemptAlias))throw new BoardConflict('acceptance_alias_missing');
  return Object.freeze({schema:marker,synthetic:true,taskAlias:a.taskAlias,attemptAlias:a.attemptAlias,
   acceptedByRole:issuer,acceptedAt:verified.acceptedAt,acceptanceVersion:atVersion,artifactSha256:verified.artifactSha256});
 }
 // Re-query only a trusted ledger and current authority selected by HOST.
 // Readback compares every portable field at the exact accepted revision.
 function verifyTrustedCopy(record,bytes,journal,selection){
  const result=compareArtifactBytes(record,bytes);
  if(result==='artifact_mismatch')return result;
  const authoritative=exportRecord(journal,{...selection,atVersion:record.acceptanceVersion});
  return facts.every(k=>record[k]===authoritative[k])?'acceptance_verified_in_ledger':'record_mismatch';
 }
 return Object.freeze({exportRecord,verifyTrustedCopy});
}
export function compareArtifactBytes(record,bytes){
 const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
 if(!record||typeof record!=='object'||(Object.getPrototypeOf(record)!==Object.prototype&&Object.getPrototypeOf(record)!==null)||
    Reflect.ownKeys(record).length!==facts.length||!facts.every(k=>own(record,k))||
    record.schema!==marker||record.synthetic!==true||record.acceptedByRole!==issuer||
    !alias(record.taskAlias)||!alias(record.attemptAlias)||!digest(record.artifactSha256)||
    !Number.isSafeInteger(record.acceptanceVersion)||record.acceptanceVersion<1||record.acceptanceVersion>4096||
    !Number.isSafeInteger(record.acceptedAt)||record.acceptedAt<0)throw new TypeError('invalid acceptance copy');
 if(!(bytes instanceof Uint8Array))throw new TypeError('raw artifact bytes required');
 return createHash('sha256').update(bytes).digest('hex')===record.artifactSha256?'artifact_matches_unverified_record':'artifact_mismatch';
}
