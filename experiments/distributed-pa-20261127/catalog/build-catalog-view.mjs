import fs from 'node:fs';import {validateCatalog,gateRoute} from './capability-gates.mjs';
const source=process.argv[2]||new URL('./market-foundation.json',import.meta.url);
const output=process.argv[3]||new URL('./Rivule-PA-接入清单.html',import.meta.url);
const data=JSON.parse(fs.readFileSync(source,'utf8'));
const catalog=validateCatalog(data);
for(const item of catalog.values())for(const r of item.routes){
 if(gateRoute({row:item,mode:r.mode}).state.includes('eligible')) throw Error('Unbound provider marked ready');
}
const sourceJSON=JSON.stringify(data).replaceAll('<','\\u003c');
const tpl=fs.readFileSync(new URL('./catalog-view.template.html',import.meta.url),'utf8');
if(tpl.split('/*DATA*/').length!==2)throw Error('missing template slot');
fs.writeFileSync(output,tpl.replace('/*DATA*/',()=>sourceJSON));
