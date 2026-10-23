import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {qqSettingsClient} from '../src/owner/presentation.mjs';
const policy={daily_limit:100,minimum_interval_ms:3000,progress_window_ms:60000,source_mode:'all_currently_verified',project_ids:['existing-project'],new_only:true};
const ready=()=>({state:'ready',csrf:'csrf-test',access_expires_at:new Date(Date.now()+120000).toISOString(),settings:{recipient_label:'本人 QQ · 已绑定',bound:true,budget:{mode:'warn',minutes:30,revision:4,remaining_ms:600000},notification:{state:'paused',remaining_daily:95},gateway:{connected:true,running:true,healthy:true},policy,can_enable:true}});
const prepared=(operation='enable')=>({state:'prepared',operation_ref:'opaque-ref',expires_at:new Date(Date.now()+30000).toISOString(),confirmation:{operation,recipient_label:'本人 QQ · 已绑定',policy,budget:{mode:'stop',minutes:45,revision:4},sends_verification:operation==='enable'}});
function setup(handler){
 class Element {constructor(){this.children=[];this.textContent='';this.value='';this.listeners={};this.open=false;this.hidden=false;}addEventListener(k,v){this.listeners[k]=v;}replaceChildren(...nodes){this.children=nodes;}showModal(){this.open=true;}close(){this.open=false;}focus(){this.focused=true;}}
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};const document=new Element(),window=new Element();document.getElementById=get;document.createElement=()=>new Element();
 const calls=[],timers=new Map();let timerId=0;
 vm.runInNewContext('('+qqSettingsClient.toString()+')()', {document,window,Date,AbortController,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{const call={url,body:options.body?JSON.parse(options.body):null,options};calls.push(call);const result=await handler(call,calls);if(result?.status)return {ok:false,status:result.status,json:async()=>({error:'test'})};return {ok:true,status:200,json:async()=>result};}});
 return {get,calls,document,window,timers,click:async id=>{await get(id).listeners.click?.();await flush();},open:async()=>{await get('settings-toggle').listeners.click();await flush();}};
}
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
test('opening management reads only; capability access requires explicit owner click',async()=>{
 let authorized=false;const c=setup(async call=>{if(call.url.endsWith('/access')){authorized=true;return {state:'authorized'};}return authorized?ready():{state:'access_required',csrf:'csrf-test'};});
 await c.open();assert.deepEqual(c.calls.map(x=>x.options.method),['GET']);assert.equal(c.get('business-access').hidden,false);
 await c.click('business-access');assert.deepEqual(c.calls.map(x=>x.url.split('/').pop()),['qq-settings','access','qq-settings']);assert.equal(c.calls[1].body.confirm,true);assert.equal(c.get('business-ready').hidden,false);
});
test('enable has separate preview and confirm actions with exact scope and no automatic send',async()=>{
 const c=setup(async call=>call.url.endsWith('/prepare')?prepared():call.url.endsWith('/commit')?{state:'active'}:ready());await c.open();await c.click('business-preview');
 assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,0);assert.equal(c.get('enable-dialog').open,true);assert.match(c.get('enable-content').children[1].textContent,/existing-project/);assert.match(c.get('enable-content').children[1].textContent,/当前已验证 PA/);
 await c.click('enable-confirm');assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,1);assert.equal(c.calls.find(x=>x.url.endsWith('/commit')).body.operation_ref,'opaque-ref');assert.equal(c.get('enable-dialog').open,false);assert.equal(c.get('enable-content').children.length,0);
 await c.click('enable-confirm');assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,1);
});
test('cancel and settings close discard prepared operation and restore focus',async()=>{
 const c=setup(async call=>call.url.endsWith('/prepare')?prepared():ready());await c.open();await c.click('business-preview');await c.click('enable-cancel');assert.equal(c.get('business-preview').focused,true);await c.click('enable-confirm');assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,0);
 await c.click('business-preview');c.get('settings').listeners.close();assert.equal(c.get('business-ready').hidden,true);assert.equal(c.get('business-recipient').textContent,'');assert.equal(c.get('enable-dialog').open,false);await c.click('enable-confirm');assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,0);
});
test('unknown commit result is never retried and only triggers a fresh read',async()=>{
 const c=setup(async call=>{if(call.url.endsWith('/prepare'))return prepared();if(call.url.endsWith('/commit'))throw Error('offline');return ready();});await c.open();await c.click('business-preview');await c.click('enable-confirm');assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,1);assert.equal(c.calls.at(-1).options.method,'GET');assert.match(c.get('business-feedback').textContent,/未自动重试/);assert.equal(c.get('enable-content').children.length,0);
});
test('duplicate enable click is single flight and hidden page invalidates in-flight preview',async()=>{
 let resolve;const c=setup(async call=>call.url.endsWith('/prepare')?new Promise(r=>resolve=r):ready());await c.open();const first=c.click('business-preview');await flush();await c.click('business-preview');assert.equal(c.calls.filter(x=>x.url.endsWith('/prepare')).length,1);
 c.document.hidden=true;c.document.listeners.visibilitychange();resolve(prepared());await first;assert.equal(c.get('enable-dialog').open,false);assert.equal(c.get('enable-content').children.length,0);assert.equal(c.get('business-recipient').textContent,'');
});
test('budget accepts strict integer minutes and does not enable after save',async()=>{
 const c=setup(async call=>call.url.endsWith('/prepare')?prepared('budget'):call.url.endsWith('/commit')?{state:'saved'}:ready());await c.open();c.get('budget-mode').value='stop';c.get('budget-minutes').value='45.5';c.get('business-budget').listeners.submit({preventDefault(){}});await flush();assert.equal(c.calls.length,1);
 c.get('budget-minutes').value='45';c.get('business-budget').listeners.submit({preventDefault(){}});await flush();assert.equal(c.calls.find(x=>x.url.endsWith('/prepare')).body.minutes,45);assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,1);assert.match(c.get('business-feedback').textContent,/保持暂停/);assert.equal(c.calls.some(x=>x.body?.operation==='enable'),false);
});
test('expired preview and authorization remove secrets without any write',async()=>{
 const c=setup(async call=>call.url.endsWith('/prepare')?prepared():ready());await c.open();await c.click('business-preview');const previewTimer=[...c.timers.values()].find(x=>x.ms<40000);previewTimer.fn();await flush();assert.equal(c.get('enable-dialog').open,false);assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,0);
 const accessTimer=[...c.timers.values()].find(x=>x.ms>60000);accessTimer.fn();await flush();assert.equal(c.calls.filter(x=>x.options.method==='POST').length,1);
});
test('401 and conflict clear old preview before any fresh read',async()=>{
 let authorized=true;const c=setup(async call=>call.url.endsWith('/prepare')?prepared():call.url.endsWith('/commit')?(authorized=false,{status:409}):authorized?ready():{status:401});await c.open();await c.click('business-preview');await c.click('enable-confirm');assert.equal(c.get('business-ready').hidden,true);assert.equal(c.get('business-recipient').textContent,'');assert.equal(c.get('enable-content').children.length,0);assert.match(c.get('business-feedback').textContent,/验证本人/);
});

test('normalized budget or changed binding stops before commit and refreshes scope',async()=>{
 for(const change of ['budget','recipient','scope']){
 const c=setup(async call=>{if(call.url.endsWith('/prepare')){const p=prepared('budget');if(change==='budget')p.confirmation.budget.minutes=44;if(change==='recipient')p.confirmation.recipient_label='changed';if(change==='scope')p.confirmation.policy={...policy,project_ids:['other']};return p;}return ready();});await c.open();c.get('budget-mode').value='stop';c.get('budget-minutes').value='45';c.get('business-budget').listeners.submit({preventDefault(){}});await flush();assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,0);assert.match(c.get('business-feedback').textContent,/重新核对/);
 }
});

test('legacy read-only session offers explicit reauthentication and never grants management silently',async()=>{
 const c=setup(async()=>({status:401}));await c.open();assert.equal(c.get('business-reauth').hidden,false);assert.equal(c.get('business-access').hidden,true);assert.equal(c.calls.length,1);assert.equal(c.calls[0].options.method,'GET');assert.match(c.get('business-feedback').textContent,/重新验证本人/);
});

test('project scope comparison cannot collide through display separators',async()=>{
 const c=setup(async call=>{if(call.url.endsWith('/prepare')){const p=prepared('pause');p.confirmation.policy={...policy,project_ids:['a','b']};return p;}const r=ready();r.settings.policy={...policy,project_ids:['a、b']};return r;});await c.open();await c.click('business-pause');assert.equal(c.calls.filter(x=>x.url.endsWith('/commit')).length,0);assert.match(c.get('business-feedback').textContent,/重新核对/);
});
