import {validOrigin,conversationUrl,sameBinding} from './policy.js';
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
let busy=false;
async function state(){return chrome.storage.local.get(['config','spool','pendingReport','lastStatus']);}
async function api(config,path,data){
  if(!validOrigin(config.origin))throw Error('控制面地址不在扩展授权名单');
  const response=await fetch(config.origin+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.token},credentials:'omit',redirect:'error',body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok){const e=Error(result.error?.message||result.error||'HTTP '+response.status);e.status=response.status;throw e;}return result;
}
async function status(message){await chrome.storage.local.set({lastStatus:message});}
async function deliver(config,report){const saved=await state();if(saved.pendingReport&&JSON.stringify(saved.pendingReport)!==JSON.stringify(report))throw Error('已有待确认回执，不覆盖为另一结果');await chrome.storage.local.set({pendingReport:report});await api(config,'/api/connector/result',report);await chrome.storage.local.remove(['pendingReport','spool']);await status('回执已保存：'+report.status);}
async function observeExisting(s){
  let active;try{active=await chrome.tabs.sendMessage(s.spool.tabId,{type:'RIVULE_STATUS'});}catch{}
  if(s.config.armed&&active?.job_id===s.spool.job.job_id){
    try{const ack=await api(s.config,'/api/connector/heartbeat',{job_id:s.spool.job.job_id,lease_token:s.spool.job.lease_token});await chrome.tabs.sendMessage(s.spool.tabId,{type:'RIVULE_LEASE',job_id:s.spool.job.job_id,lease_expires_at:ack.lease_expires_at});return;}
    catch(e){if([409,410].includes(e.status)){await chrome.tabs.sendMessage(s.spool.tabId,{type:'RIVULE_ABORT',job_id:s.spool.job.job_id}).catch(()=>{});await chrome.storage.local.remove('spool');await status('任务租约已撤销；停止协调，原页面由你控制');return;}throw e;}
  }
  await chrome.tabs.sendMessage(s.spool.tabId,{type:'RIVULE_ABORT',job_id:s.spool.job.job_id}).catch(()=>{});
  await deliver(s.config,{job_id:s.spool.job.job_id,lease_token:s.spool.job.lease_token,status:'unknown',error:{code:'connector_interrupted',message:'页面观察中断或连接器停用；原页面发送状态待人工核对，未自动重发'}});
}
async function tick(){if(busy)return;busy=true;try{
  const s=await state();if(!s.config)return;if(s.pendingReport){try{await deliver(s.config,s.pendingReport);}catch(e){if([409,410].includes(e.status)){await chrome.storage.local.remove(['pendingReport','spool']);await status('租约已撤销；旧回执未写入，请在原页面核对');}else throw e;}return;}
  if(s.spool){await observeExisting(s);return;}if(!s.config.armed)return;
  if(Date.parse(s.config.expires_at)<=Date.now())throw Error('连接凭据已过期，请在工作台重新生成并续绑');
  const tabs=await chrome.tabs.query({url:s.config.platform==='chatgpt'?'https://chatgpt.com/*':'https://gemini.google.com/*'});
  const matches=tabs.filter(t=>t.url===s.config.url);if(matches.length!==1)throw Error('请仅打开一个已绑定的任务会话标签页');
  // A preflight guard runs before claiming. It cannot send or mutate the page.
  const ready=await chrome.tabs.sendMessage(matches[0].id,{type:'RIVULE_PREFLIGHT',config:{platform:s.config.platform,url:s.config.url}});if(!ready?.ok)throw Error(ready?.error||'会话尚未准备好');
  const {job}=await api(s.config,'/api/connector/claim',{});if(!job){await status('等待任务 · 已绑定 '+s.config.platform);return;}
  await chrome.storage.local.set({spool:{job,phase:'claimed',tabId:matches[0].id}});await status('运行 '+job.task_id);
  const current=await state();if(!current.config?.armed){await deliver(s.config,{job_id:job.job_id,lease_token:job.lease_token,status:'blocked',error:{code:'connector_disarmed_before_send',message:'领取期间已停用；输入尚未交给页面'}});return;}
  try {const delivery=await chrome.tabs.sendMessage(matches[0].id,{type:'RIVULE_RUN',job,config:{platform:s.config.platform,url:s.config.url}});if(!delivery?.ok)throw Error('页面未确认接收');}catch(e){await deliver(s.config,{job_id:job.job_id,lease_token:job.lease_token,status:'unknown',error:{code:'tab_delivery_unknown',message:'页面投递状态未知，请人工核对，未自动重发'}});}
}catch(e){await status(e.message);}finally{busy=false;}}
chrome.alarms.create('rivule-poll',{periodInMinutes:.5});chrome.alarms.onAlarm.addListener(()=>tick());
chrome.runtime.onMessage.addListener((message,sender,respond)=>{(async()=>{
  if(sender.id!==chrome.runtime.id)throw Error('调用来源无效');
  const s=await state();
  if(!sender.tab){
    if(message.type==='STATUS')return {config:s.config?{...s.config,token:undefined}:null,lastStatus:s.lastStatus||'尚未绑定'};
    if(message.type==='CONFIGURE'){
      if(busy)throw Error('正在领取或核对回执，请稍后重试设置');
      const c=message.config;if(!c||!validOrigin(c.origin)||!conversationUrl(c.url,c.platform)||typeof c.token!=='string'||!c.workspaceId||!c.sourceId||!Number.isFinite(Date.parse(c.expires_at)))throw Error('配置、有效期或准确会话 URL 无效');
      if((s.spool||s.pendingReport)&&!(s.config?.origin===c.origin&&s.config?.workspaceId===c.workspaceId&&s.config?.sourceId===c.sourceId&&s.config?.url===c.url))throw Error('有待确认运行，只能为相同来源与会话续绑；请先核对原任务');
      await chrome.storage.local.set({config:{origin:c.origin,workspaceId:c.workspaceId,sourceId:c.sourceId,token:c.token,tokenId:c.tokenId,expires_at:c.expires_at,platform:c.platform,url:c.url,armed:false}});await status('已保存；确认当前账号与产品模式后手动启用');return {ok:true};
    }
    if(message.type==='ARM'){if(!s.config)throw Error('请先保存配置');if(busy&&message.armed)throw Error('正在领取或核对回执，请稍后启用');await chrome.storage.local.set({config:{...s.config,armed:message.armed===true}});await status(message.armed?'已启用；30 秒内检查任务':'已停用；原页面生成不会被点击停止');tick();return {ok:true};}
    if(message.type==='CLEAR'){if(busy)throw Error('正在领取或核对回执，请稍后清除');if(s.spool||s.pendingReport)throw Error('先暂停任务并核对待确认回执后再清除');await chrome.storage.local.clear();return {ok:true};}
    throw Error('未知设置操作');
  }
  if(!sameBinding(s.config,sender))throw Error('页面未绑定或连接器未启用');
  const job=s.spool?.job;if(!job||message.job_id!==job.job_id)throw Error('执行不匹配');
  if(message.type==='HEARTBEAT'){
    const phase=message.phase;if(!['claimed','sending','observing'].includes(phase))throw Error('阶段无效');
    await chrome.storage.local.set({spool:{...s.spool,phase}});
    return await api(s.config,'/api/connector/heartbeat',{job_id:job.job_id,lease_token:job.lease_token,phase});
  }
  if(message.type==='RESULT'){const report={...message.report,job_id:job.job_id,lease_token:job.lease_token};await deliver(s.config,report);return {ok:true};}
  throw Error('未知页面操作');
})().then(value=>respond({ok:true,value})).catch(e=>respond({ok:false,error:e.message,status:e.status}));return true;});
// Recover by probing an existing observer, never by sending RIVULE_RUN again.
tick();
