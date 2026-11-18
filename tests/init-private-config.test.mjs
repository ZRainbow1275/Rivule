// Test the actual copyable command printed on each page, in disposable synthetic installs.
// No account, network, real private configuration, deployment or third-party packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const root=fileURLToPath(new URL('../',import.meta.url));
const init='scripts/init-private-config.mjs', suffixes=['owner','qq'];
const file=(key,kind)=>'config/wrangler.'+key+'.'+kind+'.json';
const text=(dir,rel)=>readFileSync(join(dir,rel),'utf8');
function instructions(channel) {
  if(channel==='web') return text(root,'docs/showcase/start.html').match(/<pre id="config-commands"><code>([\s\S]*?)<\/code><\/pre>/)[1].trim();
  return text(root,'docs/OPERATIONS.md').split('<a id="owner-setup"></a>')[1].match(/```sh\n([\s\S]*?)\n```/)[1].trim();
}
function run(dir,channel,extra=[]) {
  const command=instructions(channel);
  if (command==='node '+init) return spawnSync(process.execPath,[init,...extra],{cwd:dir,encoding:'utf8'});
  // The two EXACT predecessor copy commands may run only inside the synthetic fixture.
  const base=suffixes.map(key=>'cp '+file(key,'example')+' '+file(key,'private'));
  assert.deepEqual(command.split('\n'),base,'unexpected guide command; must review before execution');
  assert.deepEqual(extra,[]);
  const runs=suffixes.map(key=>spawnSync('cp',[file(key,'example'),file(key,'private')],{cwd:dir,encoding:'utf8'}));
  return {status:runs.at(-1).status,stdout:runs.map(x=>x.stdout).join(''),stderr:runs.map(x=>x.stderr).join('')};
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'Rivule config QA '));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const path of ['scripts','config'])mkdirSync(join(dir,path));
  for(const key of suffixes)cpSync(join(root,file(key,'example')),join(dir,file(key,'example')));
  if(existsSync(join(root,init)))cpSync(join(root,init),join(dir,init));
  return dir;
}
const synthetic=key=>JSON.stringify({test_fixture:'PRESERVE_ME_'+key,custom:true})+'\n';
function setExisting(dir,key) {
  const p=join(dir,file(key,'private'));writeFileSync(p,synthetic(key));
  // Stable timestamps & distinctive POSIX mode establish that even an identical rewrite wasn't made.
  if(process.platform!=='win32')chmodSync(p,0o640);
  utimesSync(p,new Date('2010-01-01T00:00:00Z'),new Date('2010-01-01T00:00:00Z'));
  const s=statSync(p);return {text:text(dir,file(key,'private')),mode:s.mode,mtimeMs:s.mtimeMs};
}
function checkExisting(dir,key,a) {
  const s=statSync(join(dir,file(key,'private')));
  assert.deepEqual({text:text(dir,file(key,'private')),mode:s.mode,mtimeMs:s.mtimeMs},a,'must preserve '+key+' bytes, mode and mtime');
}
const ok=r=>assert.equal(r.status,0,r.stderr);
const expectedFiles=suffixes.flatMap(k=>['example','private'].map(kind=>file(k,kind).split('/')[1])).sort();
const nonzero=r=>assert.notEqual(r.status,0,'expected non-zero exit');
for(const channel of ['web','operations']){
  test(channel+': first install generates exact packaged template bytes without changing the templates',t=>{
    const d=fixture(t),before=suffixes.map(k=>readFileSync(join(d,file(k,'example'))));ok(run(d,channel));
    suffixes.forEach((k,i)=>{assert.deepEqual(readFileSync(join(d,file(k,'private'))),before[i]);assert.deepEqual(readFileSync(join(d,file(k,'example'))),before[i]);});
    assert.deepEqual(readdirSync(join(d,'config')).sort(),expectedFiles);
  });
  test(channel+': repeating the pasted command preserves two customized files byte-for-byte and metadata',t=>{
    const d=fixture(t);ok(run(d,channel));const existing=suffixes.map(k=>setExisting(d,k));
    const r=run(d,channel);ok(r);suffixes.forEach((k,i)=>checkExisting(d,k,existing[i]));
    assert.doesNotMatch(r.stdout+r.stderr,/PRESERVE_ME_/);
  });
  for(const keep of suffixes)test(channel+': previous '+keep+' configuration stays intact; only its missing peer is created',t=>{
    const d=fixture(t),saved=setExisting(d,keep),missing=suffixes.find(k=>k!==keep);const r=run(d,channel);ok(r);
    checkExisting(d,keep,saved);assert.equal(text(d,file(missing,'private')),text(d,file(missing,'example')));
    assert.match(r.stdout,new RegExp('已保留.*'+keep));assert.match(r.stdout,new RegExp('已建立.*'+missing));
  });
}
test('all four instructions teach one guarded operation; the web copy button targets that exact command',()=>{
  const web=text(root,'docs/showcase/start.html');assert.match(web,/data-copy="config-commands"/);assert.equal(instructions('web'),'node '+init);
  assert.equal(instructions('operations'),instructions('web'));
  for(const p of ['docs/AI_HANDOFF.zh.md','docs/GETTING_STARTED.zh.md']){assert.ok(text(root,p).includes('node '+init),p);assert.match(text(root,p),/保留/,p);}
});
test('fresh private files are owner-only on POSIX; existing modes are never adjusted',t=>{
  if(process.platform==='win32')return t.skip('POSIX modes not available');
  const d=fixture(t);ok(run(d,'operations'));for(const k of suffixes)assert.equal(statSync(join(d,file(k,'private'))).mode & 0o077,0);
});
test('a directory in place of a private file is preserved and reported before creating its missing peer',t=>{
  const d=fixture(t),bad=join(d,file('qq','private'));mkdirSync(bad);writeFileSync(join(bad,'existing.txt'),'keep');
  const r=run(d,'operations');nonzero(r);assert.match(r.stderr,/不是普通文件/);assert.equal(existsSync(join(d,file('owner','private'))),false);assert.deepEqual(readdirSync(bad),['existing.txt']);
});
for(const state of ['missing','invalid'])test('second template '+state+': reports it before creating the first private file',t=>{
  const d=fixture(t),bad=join(d,file('qq','example'));
  if(state==='missing')unlinkSync(bad);else writeFileSync(bad,'not JSON — SENTINEL_CONTENT');
  const r=run(d,'web');nonzero(r);for(const k of suffixes)assert.equal(existsSync(join(d,file(k,'private'))),false);
  assert.doesNotMatch(r.stderr,/SENTINEL_CONTENT/);
});
test('a rerun with both files present does not need template contents and only reports file paths',t=>{
  const d=fixture(t),saved=suffixes.map(k=>setExisting(d,k));for(const k of suffixes)unlinkSync(join(d,file(k,'example')));
  const r=run(d,'web');ok(r);suffixes.forEach((k,i)=>checkExisting(d,k,saved[i]));assert.doesNotMatch(r.stdout+r.stderr,/PRESERVE_ME_/);
});
test('a second invocation in another process cannot replace a config during concurrent initialization',async t=>{
  const d=fixture(t),owner=setExisting(d,'owner');assert.ok(existsSync(join(d,init)),'no guarded initializer on this revision');
  const results=await Promise.all(Array.from({length:6},()=>new Promise((resolve,reject)=>{
    const c=spawn(process.execPath,[init],{cwd:d,stdio:['ignore','pipe','pipe']});let out='',err='';
    c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',code=>resolve({code,out,err}));})));
  for(const r of results)assert.equal(r.code,0,r.err);
  assert.equal(results.filter(r=>/已建立 config\/wrangler\.qq\.private\.json/.test(r.out)).length,1);
  checkExisting(d,'owner',owner);assert.equal(text(d,file('qq','private')),text(d,file('qq','example')));assert.deepEqual(readdirSync(join(d,'config')).sort(),expectedFiles);
});
test('--help and an unrecognized option write nothing',t=>{
  const d=fixture(t);assert.ok(existsSync(join(d,init)),'no guarded initializer on this revision');
  for(const f of ['--help','--other']){const r=spawnSync(process.execPath,[init,f],{cwd:d,encoding:'utf8'});if(f==='--help')ok(r);else nonzero(r);}
  assert.deepEqual(readdirSync(join(d,'config')).sort(),suffixes.map(k=>file(k,'example').split('/')[1]).sort());
});
