import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {documentName,replay,sample,sameNameChanged} from './acceptance-demo.mjs';
const root=new URL('./portable-acceptance/',import.meta.url),result=replay();
const content=[
 ['original/'+documentName,sample],
 ['edited/'+documentName,sameNameChanged],
 ['acceptance.json',Buffer.from(JSON.stringify(result.record,null,2)+'\n')],
 ['verification.json',Buffer.from(JSON.stringify(result.cases,null,2)+'\n')]
];
for(const [name,bytes] of content){
 const path=new URL(name,root);
 if(process.argv.includes('--check'))assert.deepEqual(readFileSync(path),bytes,name);
 else writeFileSync(path,bytes);
}
console.log(JSON.stringify({assets:content.length,checks:result.cases}));
