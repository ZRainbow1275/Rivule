'use strict';
const A=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function node(tag){return {tag,children:[],value:'',textContent:'',addEventListener(_,fn){this.on=fn},append(...x){this.children.push(...x.flatMap(n=>n.tag==='frag'?n.children:[n]))},replaceChildren(...x){this.children=[];this.append(...x)}}}
const els=Object.fromEntries(['market','mode','search','stats','tally','cards'].map(x=>[x,node(x)]));
const doc={createElement:node,getElementById:x=>els[x],createDocumentFragment:()=>node('frag')};
const html=fs.readFileSync(process.argv[2]??'catalog/Rivule-PA-接入清单.html','utf8'),code=html.match(/<script>([\s\S]+)<\/script>/)[1];
const context={document:doc};vm.runInNewContext(code,context);
const count=()=>els.cards.children.filter(n=>n.tag==='article').length;
const all=count();A(all>=20);A.equal(els.stats.children.length,3);
els.mode.value='push';els.mode.on();A(count()>0&&count()<all);
els.mode.value='';els.market.value='cn';els.market.on();A(count()>0&&count()<all);
els.market.value='';els.search.value='Glean';els.search.on();A.equal(count(),1);A(els.cards.children[0].children[0].textContent.includes('Glean'));
els.search.value='no-provider-should-exist';els.search.on();A.equal(count(),0);A.equal(els.cards.children[0].tag,'p');
A(!/https?:[^\s"'<>]+[?&](token|secret|key)=/i.test(html));
console.log(JSON.stringify({verified:all,search:true,filter:true,empty:true,recipientNetworkCalls:0}));
