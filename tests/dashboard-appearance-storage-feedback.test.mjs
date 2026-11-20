import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
// Evaluate the actual self-contained inline client without booting server integrations.
const source=readFileSync(process.env.PRESENTATION_SOURCE || new URL('../src/owner/presentation.mjs',import.meta.url),'utf8');
const client=source.slice(source.indexOf('export function dashboardClient('),source.indexOf('export function qqSettingsClient(')).replace(/^export /,'');
const dashboardClient=vm.runInNewContext('('+client.trim()+')');
const selectedWorkbench=()=>{throw Error('unexpected snapshot derivation');};
function clientFixture(fetch, storage, timers = {}) {
  class Element {
    constructor() { this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  return { get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}



const key='rivule.appearance.zot-main.v1';
for(const kind of ['name','icon']) for(const failure of [false,true]) test(kind+' save reports '+(failure?'storage failure':'success'),()=>{
 const values=new Map([[key,JSON.stringify({name:'Original',icon:'⭐'})]]);let writes=0,reads=0;
 const c=clientFixture(()=>{reads++;throw Error('unexpected network');},{getItem:k=>values.get(k),setItem:(k,v)=>{writes++;if(failure)throw Error('private storage error');values.set(k,v);}});
 const target=kind==='name'?'zot-name':'zot-emblem',field=kind==='name'?'display-name':'icon-value',next=kind==='name'?'Updated':'🌈';
 c.get(kind==='name'?'rename-zot':'zot-emblem').listeners.click({currentTarget:c.get(target)});c.get(field).value=next;c.get(kind+'-form').listeners.submit({preventDefault(){}});
 assert.equal(c.get(target).textContent,next);assert.equal(c.get(kind+'-dialog').open,false);assert.equal(writes,1);assert.equal(reads,0);
 assert.equal(c.get('status').textContent,failure?'外观已应用，但此浏览器未能保存':'外观已保存到此浏览器');assert.doesNotMatch(c.get('status').textContent,/private storage error/);
 assert.equal(JSON.parse(values.get(key))[kind],failure?(kind==='name'?'Original':'⭐'):next);
});
test('successful retry saves both current appearance fields and clears previous failure',()=>{let blocked=true,value;const c=clientFixture(()=>{throw Error('unexpected network');},{getItem:()=>null,setItem:(k,v)=>{if(blocked)throw Error('blocked');value=v;}});c.get('display-name').value='Updated';c.get('name-form').listeners.submit({preventDefault(){}});assert.match(c.get('status').textContent,/未能保存/);blocked=false;c.get('zot-emblem').listeners.click({currentTarget:c.get('zot-emblem')});c.get('icon-value').value='🌈';c.get('icon-form').listeners.submit({preventDefault(){}});assert.deepEqual(JSON.parse(value),{name:'Updated',icon:'🌈'});assert.equal(c.get('status').textContent,'外观已保存到此浏览器');});
