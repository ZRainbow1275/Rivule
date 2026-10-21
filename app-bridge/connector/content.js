(() => {
  let running=false,active=null;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const visible=e=>!!e&&e.getClientRects().length>0;
  function mode(config){
    const chatgpt=config.platform==='chatgpt';
    if(chatgpt){
      const work=[...document.querySelectorAll('header button[aria-pressed="true"]')].some(b=>/^Work$/i.test(b.textContent.trim()));if(work)throw Error('当前是 Work，不是普通网页 Pro');
      const models=[...document.querySelectorAll('[data-testid="model-switcher-dropdown-button"],main button[data-codex-intelligence-trigger="true"][aria-haspopup="menu"]')].filter(visible);
      const pro=models.length===1&&[models[0],...models[0].querySelectorAll('span')].some(n=>/^Pro$/i.test(n.textContent.trim()));
      if(!pro)throw Error('请在原产品选择 Pro；当前页面无法可靠确认模式');
    }else{
      const selected=[...document.querySelectorAll('gem-segmented-button.gem-segmented-button-selected button')].filter(visible);
      if(selected.length!==1||! /^(Task|Tasks|任务)$/i.test(selected[0].textContent.trim()))throw Error('请选择 Gemini Task；普通 Chat 不执行任务');
    }
    return chatgpt;
  }
  function snapshot(config){
    if(location.href!==config.url)throw Error('当前 URL 与绑定会话不同');
    const chatgpt=mode(config);
    const stop=[...document.querySelectorAll('button')].some(b=>visible(b)&&/stop|停止|取消生成|zatrzymaj/i.test((b.getAttribute('aria-label')||'')+' '+(b.dataset.testid||'')));
    if(stop)throw Error('原页面正在生成，请等待或由你手动停止');
    const boxes=[...document.querySelectorAll(chatgpt?'#prompt-textarea,main form [data-composer-markdown][role="textbox"][contenteditable="true"]':'main rich-textarea [contenteditable="true"]')].filter(visible);
    if(boxes.length!==1)throw Error('找不到唯一可见的输入框');const box=boxes[0];
    const draft=box.value??box.innerText??box.textContent;if(draft?.trim())throw Error('输入框已有草稿，连接器不会覆盖');
    const form=box.closest('form,input-area-v2,.input-area-container');if(!form)throw Error('无法确认输入框与发送按钮的共同边界');
    return {box,form,chatgpt};
  }
  function sendButton(form,chatgpt){
    const buttons=[...form.querySelectorAll(chatgpt?'button[data-testid="send-button"],button[type="submit"]':'button.send-button,button[aria-label="Send message"],button[aria-label="发送消息"]')].filter(visible);
    const candidates=buttons.filter(b=>/^(send|send prompt|send message|发送|发送消息|发送提示|wyślij)$/i.test((b.getAttribute('aria-label')||b.textContent||'').trim()));
    if(candidates.length!==1)throw Error('无法确认唯一发送按钮；不会使用 Enter 或替代审批按钮');return candidates[0];
  }
  async function message(value){const r=await chrome.runtime.sendMessage(value);if(!r?.ok){const e=Error(r?.error||'连接器中断');e.status=r?.status;throw e;}return r.value;}
  function responses(chatgpt){return [...document.querySelectorAll(chatgpt?'[data-message-author-role="assistant"]':'model-response')].filter(visible);}
  async function execute(job,config){let phase='claimed';let sent=false,terminalAttempted=false;active={job_id:job.job_id,phase,deadline:Date.parse(job.lease_expires_at),stopped:false,aborted:false};
    try{
      const {box,form,chatgpt}=snapshot(config);const before=responses(chatgpt);const ids=new Set(before.map(n=>n.dataset.messageId).filter(Boolean));const userSelector=chatgpt?'[data-message-author-role="user"]':'user-query';const userCount=document.querySelectorAll(userSelector).length;
      await message({type:'HEARTBEAT',job_id:job.job_id,phase:'sending'});phase='sending';active.phase=phase;
      box.focus();if(box.isContentEditable){if(!document.execCommand('insertText',false,job.arguments.input))throw Error('编辑器拒绝输入，请人工核对草稿');}else{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;if(!setter)throw Error('输入框类型不支持');setter.call(box,job.arguments.input);box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:job.arguments.input}));}
      await pause(500);if((box.value??box.innerText??box.textContent).trim()!==job.arguments.input.trim())throw Error('输入校验失败，保留草稿供人工核对');
      mode(config);const send=sendButton(form,chatgpt);if(active.aborted||location.href!==config.url||send.disabled||send.getAttribute('aria-disabled')==='true'||!visible(send))throw Error('发送前状态改变，保留草稿供人工核对');
      send.click();sent=true;phase='observing';active.phase=phase;
      const ack=await message({type:'HEARTBEAT',job_id:job.job_id,phase});active.deadline=Date.parse(ack.lease_expires_at);let heartbeatAt=Date.now(),stable=0,last='';const started=Date.now();
      while(Date.now()-started<3*60*60*1000){
        await pause(2000);if(active.aborted)return;if(active.stopped)throw Error('用户已在原页面停止生成，请人工核对部分输出');if(location.href!==config.url)throw Error('任务页面已离开');
        if(Date.now()>active.deadline)throw Error('执行租约已到期');
        if(Date.now()-heartbeatAt>20000){const h=await message({type:'HEARTBEAT',job_id:job.job_id,phase});active.deadline=Date.parse(h.lease_expires_at);heartbeatAt=Date.now();}
        if(document.querySelectorAll(userSelector).length>userCount+1)throw Error('原页面出现了额外用户消息，停止归属判断');
        const candidates=responses(chatgpt).filter((n,i)=>n.dataset.messageId?!ids.has(n.dataset.messageId):i>=before.length);const node=candidates.at(-1);const text=node?.innerText?.trim()||'';
        const generating=[...document.querySelectorAll('button')].some(b=>visible(b)&&/stop|停止|取消生成|zatrzymaj/i.test((b.getAttribute('aria-label')||'')+' '+(b.dataset.testid||'')));
        const finished=node?.querySelector('button[aria-label*="Copy"],button[aria-label*="复制"],button[aria-label*="Kopiuj"],[data-testid="copy-turn-action-button"],copy-button');
        stable=text&&text===last&&!generating&&finished?stable+1:0;last=text;
        if(stable>=3){
          const report={status:'succeeded',result:{text,url:config.url,platform:config.platform}};
          if(new TextEncoder().encode(text).length>220000||new TextEncoder().encode(JSON.stringify({...report,job_id:job.job_id,lease_token:job.lease_token})).length>262144)throw Error('输出超过回执限额，请人工导出；未截断保存');
          terminalAttempted=true;await message({type:'RESULT',job_id:job.job_id,report});return;
        }
      }throw Error('观察超过 3 小时，请人工核对原页面');
    }catch(e){if(terminalAttempted||active?.aborted||[409,410].includes(e.status))return;try{await message({type:'RESULT',job_id:job.job_id,report:{status:sent||phase!=='claimed'?'unknown':'blocked',error:{code:sent?'observation_interrupted':'page_guard',message:String(e.message).slice(0,1900)}}});}catch{} }
    finally{running=false;active=null;}
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='RIVULE_STATUS'){respond(active?{job_id:active.job_id,phase:active.phase}:null);return;}
    if(message.type==='RIVULE_LEASE'){if(active?.job_id===message.job_id)active.deadline=Date.parse(message.lease_expires_at);respond({ok:true});return;}
    if(message.type==='RIVULE_ABORT'){if(active?.job_id===message.job_id)active.aborted=true;respond({ok:true});return;}
    if(message.type==='RIVULE_PREFLIGHT'){try{if(running)throw Error('本页面已有任务');snapshot(message.config);respond({ok:true});}catch(e){respond({ok:false,error:e.message});}return;}
    if(message.type==='RIVULE_RUN'){if(running){respond({ok:false,error:'本页面已有任务'});return;}running=true;respond({ok:true});execute(message.job,message.config);}
  });
  document.addEventListener('click',event=>{const b=event.target.closest?.('button');if(active&&event.isTrusted&&b&&/stop|停止|取消生成|zatrzymaj/i.test((b.getAttribute('aria-label')||'')+' '+(b.dataset.testid||'')))active.stopped=true;},true);
})();
