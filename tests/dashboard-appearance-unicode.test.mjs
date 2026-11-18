import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {ownerDashboardHtml,dashboardClient,selectedWorkbench} from '../src/owner/presentation.mjs';
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
function setup(initial){const saved=new Map(initial?[[key,JSON.stringify(initial)]]:[]);const c=clientFixture(async()=>({status:401}),{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)});return {...c,saved};}
function submit(c,kind,text){c.get(kind==='icon'?'zot-emblem':'rename-zot').listeners.click({currentTarget:c.get(kind==='icon'?'zot-emblem':'rename-zot')});c.get(kind==='icon'?'icon-value':'display-name').value=text;c.get(kind+'-form').listeners.submit({preventDefault(){}});return JSON.parse(c.saved.get(key));}
for(const [label,unit] of [['family','👨‍👩‍👧‍👦'],['flag','🇨🇳'],['skin tone','👍🏽'],['combining accent','e\u0301']]){
 test('icon preserves '+label,()=>{const c=setup(),value=unit.repeat(9);const result=submit(c,'icon',value);assert.equal(result.icon,unit.repeat(8));assert.equal(c.get('zot-emblem').textContent,result.icon);assert.equal(setup(result).get('zot-emblem').textContent,result.icon);});
 test('name preserves '+label,()=>{const c=setup();const result=submit(c,'name',unit.repeat(33));assert.equal(result.name,unit.repeat(32));assert.equal(setup(result).get('zot-name').textContent,result.name);});
}
test('legacy names and icons still restore',()=>{const c=setup({name:'  Zot  ',icon:'⭐'});assert.equal(c.get('zot-name').textContent,'Zot');assert.equal(c.get('zot-emblem').textContent,'⭐');});
test('blank submit preserves saved value',()=>{const c=setup({name:'Zot',icon:'⭐'});submit(c,'name','  ');assert.equal(c.get('zot-name').textContent,'Zot');});
test('inputs allow whole multi-code-unit characters',()=>{const html=ownerDashboardHtml('test');assert.match(html,/id="icon-value" maxlength="4096"/);assert.match(html,/id="display-name" maxlength="4096"/);});
test('oversized and malformed saved values are ignored',()=>{const c=setup({name:'a'.repeat(33),icon:['⭐']});assert.equal(c.get('zot-name').textContent,'');assert.equal(c.get('zot-emblem').textContent,'');});
test('code-unit safety cap preserves previous appearance',()=>{const c=setup({name:'Zot',icon:'⭐'});assert.equal(submit(c,'name','a'.repeat(4097)).name,'Zot');});
test('older engine fallback never truncates a long emoji sequence',()=>{const saved=new Map([[key,JSON.stringify({name:'Zot',icon:'⭐'})]]);const c=clientFixture(async()=>({status:401}),{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},{Intl:{}});const result=submit({...c,saved},'icon','👨‍👩‍👧‍👦');assert.equal(result.icon,'⭐');});
