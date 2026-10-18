import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{repackFont,installFont,plan}from'./install-font.mjs';import{createHash}from'node:crypto';
test('reject corrupt or different-version font before output',()=>assert.throws(()=>repackFont(Buffer.from('wrong font')),/integrity mismatch/));
test('offline error has supported next step',async()=>assert.rejects(installFont(async()=>{throw Error('offline')}),/Check network access.*No substitute or partial font/));
if(process.env.RIVULE_OFFICIAL_FONT_FIXTURE)test('pinned official input reconstructs exact deployed font',()=>assert.equal(createHash('sha256').update(repackFont(readFileSync(process.env.RIVULE_OFFICIAL_FONT_FIXTURE))).digest('hex'),plan.output_sha256));
