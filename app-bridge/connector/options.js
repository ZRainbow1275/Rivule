const $=id=>document.getElementById(id);
async function send(data){const r=await chrome.runtime.sendMessage(data);if(!r?.ok)throw Error(r?.error||'扩展不可用');return r.value;}
async function refresh(){const s=await send({type:'STATUS'});$('status').textContent=s.lastStatus+(s.config?'\n'+s.config.platform+' · '+(s.config.armed?'启用':'停用')+'\n'+s.config.url+'\n有效期 '+s.config.expires_at:'');if(s.config)$('url').value=s.config.url;}
async function run(fn){try{await fn();await refresh();}catch(e){$('status').textContent=e.message;}}
$('save').onclick=()=>run(async()=>{const config=JSON.parse($('config').value);await send({type:'CONFIGURE',config:{...config,url:$('url').value.trim()}});$('config').value='';});
$('arm').onclick=()=>run(()=>send({type:'ARM',armed:true}));$('disarm').onclick=()=>run(()=>send({type:'ARM',armed:false}));$('clear').onclick=()=>run(()=>send({type:'CLEAR'}));
refresh().catch(e=>$('status').textContent=e.message);
