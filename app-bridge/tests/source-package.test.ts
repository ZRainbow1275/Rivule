import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {sourceBundle} from '../src/source.generated';
test('downloaded corresponding source can reconstruct its own source generator',async()=>{
  assert.ok(sourceBundle.files['connector/options.html']);assert.ok(sourceBundle.files.LICENSE.includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
  const config=JSON.parse(sourceBundle.files['wrangler.jsonc']);assert.equal(config.preview_urls,false);assert.equal(config.observability.redact_query_string,true);for(const channel of ['logs','traces'])assert.equal(config.observability[channel]?.head_sampling_rate,0.1);
  const parent=path.join(process.cwd(),'.runtime');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'source-package-'));
  for(const [name,content]of Object.entries(sourceBundle.files)){const target=path.resolve(dir,name);assert.ok(target.startsWith(dir+path.sep));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
  assert.match(execFileSync(process.execPath,['scripts/source-bundle.mjs'],{cwd:dir,encoding:'utf8'}),/Prepared corresponding-source/);
  const generated=await readFile(path.join(dir,'src/source.generated.ts'),'utf8');assert.ok(generated.includes('connector/options.html'));assert.ok(generated.includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
});
