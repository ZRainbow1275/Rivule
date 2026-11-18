// Real local Git repositories and filesystem exports. No network, test account or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync, readdirSync, statSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source = fileURLToPath(new URL('../', import.meta.url));
const files = ['scripts/build-showcase.mjs','tests/showcase-export.test.mjs','package.json','README.md','LICENSE',
  ...['AI_HANDOFF.zh.md','GETTING_STARTED.zh.md','INTEGRATIONS.md','OPERATIONS.md','TROUBLESHOOTING.zh.md'].map(n=>'docs/'+n),
  ...['index.html','start.html','style.css','start.css','script.js','start.js','assets/rivule-mark.svg','assets/rivule-banner.svg'].map(n=>'docs/showcase/'+n)];
function setup(t){
  const temp=mkdtempSync(join(tmpdir(),'Rivule showcase 本地 '));
  t.after(()=>rmSync(temp,{force:true,recursive:true}));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(temp,'empty-gitconfig'),GIT_TERMINAL_PROMPT:'0',
    GIT_AUTHOR_NAME:'Offline QA',GIT_AUTHOR_EMAIL:'qa@example.invalid',GIT_COMMITTER_NAME:'Offline QA',GIT_COMMITTER_EMAIL:'qa@example.invalid'};
  for(const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR'])delete env[k];
  const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const fixture=(name='Rivule',root=temp)=>{const dir=join(root,name);mkdirSync(dir,{recursive:true});
    for(const path of files){mkdirSync(dirname(join(dir,path)),{recursive:true});cpSync(join(source,path),join(dir,path));}return dir;};
  const init=(dir,commit=true)=>{git(dir,'init','-q');if(commit){git(dir,'add','--','.');git(dir,'commit','-qm','Offline test inputs');}return dir;};
  const build=dir=>spawnSync(process.execPath,['scripts/build-showcase.mjs'],{cwd:dir,env,encoding:'utf8'});
  const originalTest=dir=>spawnSync(process.execPath,['--test','tests/showcase-export.test.mjs'],{cwd:dir,env,encoding:'utf8'});
  const out=dir=>join(dir,'dist','showcase');
  const hashes=dir=>{
    const entries={};function walk(p){for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else entries[f.slice(pRoot.length+1)]=createHash('sha256').update(readFileSync(f)).digest('hex');}}
    const pRoot=out(dir);if(existsSync(pRoot))walk(pRoot);return entries;};
  const links=dir=>['index.html','start.html'].flatMap(n=>[...readFileSync(join(out(dir),n),'utf8').matchAll(/href="(https:\/\/github\.com\/ZRainbow1275\/Rivule\/blob\/[^"]+)"/g)].map(m=>m[1]));
  const clean=()=>init(fixture());
  const unrelated=()=>{const dir=join(temp,'unrelated');mkdirSync(dir);writeFileSync(join(dir,'work.txt'),'Separate repository');return init(dir);};
  return {temp,git,fixture,init,build,originalTest,out,hashes,links,clean,unrelated};
}
function ok(r){assert.equal(r.status,0,r.stderr);}
function blocked(r){assert.notEqual(r.status,0);}
test('clean checkout: actual export links target this HEAD and packaged assets exist',t=>{
  const c=setup(t),d=c.clean();ok(c.build(d));const rev=c.git(d,'rev-parse','HEAD'),links=c.links(d);
  assert.ok(links.length>=15);assert.ok(links.every(x=>x.includes('/blob/'+rev+'/')));assert.equal(Object.keys(c.hashes(d)).length,8);
});
test('normal checkout continues to pass the existing upstream showcase integration test',t=>{
  const c=setup(t),d=c.clean();const run=c.originalTest(d);assert.equal(run.status,0,run.stdout+' '+run.stderr);
});
test('a real linked worktree with a .git pointer file exports correctly',t=>{
  const c=setup(t),repo=c.clean(),d=join(c.temp,'linked');c.git(repo,'worktree','add','-q','--detach',d,'HEAD');assert.ok(statSync(join(d,'.git')).isFile());
  ok(c.build(d));const rev=c.git(d,'rev-parse','HEAD');assert.ok(c.links(d).every(l=>l.includes('/blob/'+rev+'/')));
});
test('a legitimate independent repository nested under a different repository uses its own commit',t=>{
  const c=setup(t),outer=c.unrelated(),d=c.init(c.fixture('Rivule',outer));const rev=c.git(d,'rev-parse','HEAD');assert.notEqual(rev,c.git(outer,'rev-parse','HEAD'));
  ok(c.build(d));assert.ok(c.links(d).every(l=>l.includes('/blob/'+rev+'/')));
});
test('a plain source archive does not invent a revision or create output',t=>{
  const c=setup(t),d=c.fixture();blocked(c.build(d));assert.equal(existsSync(c.out(d)),false);
});
test('an extracted archive nested in an unrelated Git repository refuses before creating output',t=>{
  const c=setup(t),d=c.fixture('nested',c.unrelated());assert.equal(existsSync(join(d,'.git')),false);blocked(c.build(d));assert.equal(existsSync(c.out(d)),false);
});
test('a repository with no commit cannot create a published documentation revision',t=>{
  const c=setup(t),d=c.init(c.fixture(),false);blocked(c.build(d));assert.equal(existsSync(c.out(d)),false);
});
for(const staged of [false,true])test((staged?'staged':'working-tree')+' changed target guide must not silently link to the older committed text',t=>{
  const c=setup(t),d=c.clean();ok(c.build(d));const previous=c.hashes(d),relative='docs/GETTING_STARTED.zh.md';
  writeFileSync(join(d,relative),readFileSync(join(d,relative),'utf8')+'\nNew uncommitted guide wording.\n');if(staged)c.git(d,'add','--',relative);
  blocked(c.build(d));assert.deepEqual(c.hashes(d),previous);
});
test('untracked new target guide does not generate a guaranteed missing commit link',t=>{
  const c=setup(t),d=c.clean();const page=join(d,'docs/showcase/start.html');
  writeFileSync(page,readFileSync(page,'utf8').replace('</main>','<a href="../EXTRA.md">Extra guide</a></main>'));writeFileSync(join(d,'docs/EXTRA.md'),'Example guide');
  blocked(c.build(d));assert.equal(existsSync(c.out(d)),false);
});
test('a late missing document leaves a previous export byte-for-byte intact',t=>{
  const c=setup(t),d=c.clean();ok(c.build(d));const previous=c.hashes(d);
  const index=join(d,'docs/showcase/index.html');writeFileSync(index,readFileSync(index,'utf8').replace('</main>','<p>Unpublished page change</p></main>'));
  const start=join(d,'docs/showcase/start.html');writeFileSync(start,readFileSync(start,'utf8').replace('</main>','<a href="../missing.md">Missing guide</a></main>'));
  blocked(c.build(d));assert.deepEqual(c.hashes(d),previous);
});
test('missing final image asset does not write half of a fresh showcase',t=>{
  const c=setup(t),d=c.clean();const f=join(d,'docs/showcase/assets/rivule-banner.svg');renameSync(f,f+'.missing');blocked(c.build(d));assert.equal(existsSync(c.out(d)),false);
});
test('an unrelated non-document workspace edit does not block a valid bundle',t=>{
  const c=setup(t),d=c.clean();writeFileSync(join(d,'private-work-in-progress.txt'),'not part of the public showcase');ok(c.build(d));assert.equal(Object.keys(c.hashes(d)).length,8);
  assert.ok(!Object.keys(c.hashes(d)).some(n=>n.includes('private-work')));
});
