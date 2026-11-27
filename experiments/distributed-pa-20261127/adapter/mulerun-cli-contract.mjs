// Describe only readback on the same approved local CLI identity. Never spawn a CLI
// here: its interrupt can cancel work, and timeout is not proof of non-execution.
const sid=x=>typeof x==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_-]{0,95}$/.test(x);
export function planMuleRunRecovery({binding,receipt,loss}){
 if(binding?.provider!=='mulerun-cli'||binding.verifiedOAuthExecutor!==true||!sid(binding.executorRef)||!sid(binding.lane)||
 receipt?.executorRef!==binding.executorRef||receipt?.lane!==binding.lane)
  return {state:'owner_review_no_resend',read:[]};
 if(!['stream_lost','caller_wait_expired','explicit_interrupt'].includes(loss)||!sid(receipt.sessionId))
  return {state:'original_unknown_no_resend',read:[]};
 return {state:loss==='explicit_interrupt'?'verify_cancellation':'verify_same_session',
  read:[['mulerun','session','get',receipt.sessionId,'-o','json'],
        ['mulerun','session','events',receipt.sessionId,'--limit','100','-o','jsonl']]};
}
