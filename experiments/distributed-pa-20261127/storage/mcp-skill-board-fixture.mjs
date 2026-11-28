// Dedicated offline bridge. No proof, permit, third-party description or
// provider route is exposed by the visual replay. Never register for egress.
import {createHash} from 'node:crypto';
import {makeMcpSkillFixture} from '../adapter/mcp-skill-fixture.mjs';
import {makeSqlJournal} from './sql-journal.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const scope='skill-rehearsal',task='registry-summary',worker='local-fixture-tool',subject='fixture-main';
export const localSkillCard=Object.freeze({scope,task,worker,subject,capability:'skill.fixture.read',
 inputDigest:sha('{"region":"cn"}')});
const auth=Object.freeze({scope,subject:worker,role:'worker'});
export const localSkillProfile=Object.freeze({worker,provider:'local-synthetic',lane:'offline-mcp-skill',
 dataRegions:Object.freeze(['cn-mainland']),capabilities:Object.freeze([localSkillCard.capability]),ready:true,authorized:true});
const hold=reason=>({phase:'holding',reason});
export function makeMcpSkillBoardFixture({enabled=false,sql,transactionSync,resolve,resolveApproval,clock,validatorKey}={}){
 if(enabled!==true||![transactionSync,resolve,resolveApproval,clock].every(x=>typeof x==='function'))
  throw TypeError('offline board fixture disabled');
 let enlisted=false;
 // Only fixed synchronous lab code can be enlisted; no remote callback.
 const joined=fn=>enlisted?fn():transactionSync(fn);
 const board=makeSqlJournal({sql,transactionSync:joined});board.prepare();
 const lab=makeMcpSkillFixture({enabled:true,sql,transactionSync:joined,resolveApproval,clock,validatorKey,
  resolve(request){
   const p=resolve(request);
   return p?.board===scope&&p?.subject===subject&&p?.job===task?p:null;
  }});
 const inspect=args=>lab.inspect({...args,job:task});
 const propose=args=>lab.propose({...args,job:task});
 function run({candidate,expectedVersion,at,fence}){
  return transactionSync(()=>{
   enlisted=true;
   try{
    const plan=propose(candidate);
    if(plan.phase!=='awaiting_approval')return plan;
    if(candidate.inputs.region!=='cn')return hold('fixture_card_inputs_changed');
    const snap=board.projectAll(scope),card=snap.cards.find(c=>c.task===task);
    if(snap.asOfVersion!==expectedVersion||card?.state!=='leased'||card.fence!==fence||card.worker!==worker||
      card.capability!==localSkillCard.capability)return hold('board_changed');
    // Verify and spend the exact approval before generating board events.
    // A failed append rolls the receipt and all three board events back.
    const out=lab.run({...candidate,job:task});
    if(out.phase!=='result_for_review')return out;
    const artifact=sha(JSON.stringify(out.output));
    const receipt='fixture-'+sha(out.receipt).slice(0,48);
    let version=expectedVersion;
    for(const [type,fields] of [['begin',{}],['acknowledged',{receipt}],['reported',{receipt,artifact}]]){
     const next=board.append({auth,at,expectedVersion:version,profile:localSkillProfile,
      command:{type,task,id:'local-skill-'+fence+'-'+type,fence,...fields}});
     if(!next.committed||type==='begin'&&next.permit?.inputDigest!==localSkillCard.inputDigest)
      throw Error('fixture card plan changed');
     version=next.version;
    }
    return {phase:out.phase,output:out.output,artifact,version};
   }finally{enlisted=false}
  });
 }
 return Object.freeze({inspect,propose,run});
}
