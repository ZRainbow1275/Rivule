import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const plan = JSON.parse(readFileSync(join(root, 'scripts/font-repack.json')));
const wasm = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
const typescript = dirname(require.resolve('typescript/package.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function put(root, name, contents) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(t, production = false) {
  const path = mkdtempSync(join(tmpdir(), 'rivule-build-closure-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  for (const name of ['scripts', 'assets', 'node_modules/@resvg/resvg-wasm']) mkdirSync(join(path, name), { recursive: true });
  for (const name of ['build.mjs', 'font-repack.json']) copyFileSync(join(root, 'scripts', name), join(path, 'scripts', name));
  copyFileSync(join(root, plan.output_path), join(path, plan.output_path));
  copyFileSync(wasm, join(path, 'node_modules/@resvg/resvg-wasm/index_bg.wasm'));
  symlinkSync(typescript, join(path, 'node_modules/typescript'), 'dir');
  if (production) cpSync(join(root, 'src'), join(path, 'src'), { recursive: true });
  else {
    put(path, 'src/owner/worker.js', 'import font from "./font.otf"; import wasm from "./renderer.wasm"; export default {font, wasm};\n');
    put(path, 'src/gateway/worker.mjs', 'import {DurableObject} from "cloudflare:workers"; export {DurableObject};\n');
    put(path, 'src/sdk/example.mjs', 'export const version = 1;\n');
  }
  return path;
}

function build(path) {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: path, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

// A second, independent verifier uses Node's actual module linker, not the
// TypeScript AST used by the build. It links every static edge and named export
// without executing Worker code. Only the runtime and verified binary leaves
// are stubbed; relative JS dependencies must come from the isolated dist.
function linkEntries(path, entries) {
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import {readFileSync} from 'node:fs';
    import {resolve, relative, isAbsolute, extname, sep} from 'node:path';
    import {pathToFileURL, fileURLToPath} from 'node:url';
    const root = resolve(process.argv[1]);
    const entries = JSON.parse(process.argv[2]);
    const cache = new Map();
    const runtime = new vm.SyntheticModule(['DurableObject', 'WorkerEntrypoint'], function() {
      this.setExport('DurableObject', class {}); this.setExport('WorkerEntrypoint', class {});
    });
    function load(path) {
      const name = relative(root, path);
      assert.ok(name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name));
      if (cache.has(path)) return cache.get(path);
      const bytes = readFileSync(path);
      const module = ['.js', '.mjs'].includes(extname(path))
        ? new vm.SourceTextModule(bytes.toString('utf8'), {identifier:pathToFileURL(path).href})
        : new vm.SyntheticModule(['default'], function() { this.setExport('default', bytes); });
      cache.set(path, module);
      return module;
    }
    function linker(specifier, importer) {
      if (specifier === 'cloudflare:workers') return runtime;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), specifier);
      return load(fileURLToPath(new URL(specifier, importer.identifier)));
    }
    for (const entry of entries) {
      const module = load(resolve(root, entry));
      if (module.status === 'unlinked') await module.link(linker);
      assert.equal(module.status, 'linked');
    }
    console.log(JSON.stringify([...cache.keys()].map(path => relative(root, path)).sort()));
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script, join(path, 'dist'), JSON.stringify(entries)], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('clean production build closes owner, gateway, conversation-v2 and both SDK import graphs', async t => {
  const path = fixture(t, true);
  assert.equal(existsSync(join(path, 'dist')), false);
  const result = build(path);
  assert.equal(result.status, 0, result.stderr);
  const entries = ['owner/worker.js', 'gateway/worker.mjs', 'sdk/source-bridge.mjs', 'sdk/conversation-bridge.mjs'];
  const linked = new Set(linkEntries(path, entries));
  for (const name of readdirSync(join(path, 'src/owner')).filter(name => name.startsWith('conversation-') && name.endsWith('.mjs'))) {
    assert.ok(linked.has('owner/' + name), `${name} must be in the linked output graph`);
    assert.deepEqual(readFileSync(join(path, 'dist/owner', name)), readFileSync(join(path, 'src/owner', name)));
  }
  for (const entry of entries) assert.ok(linked.has(entry), entry);
  const taskSdk = await import(pathToFileURL(join(path, 'dist/sdk/source-bridge.mjs')).href);
  const conversationSdk = await import(pathToFileURL(join(path, 'dist/sdk/conversation-bridge.mjs')).href);
  assert.equal(typeof taskSdk.createSourceBridge, 'function');
  assert.equal(typeof conversationSdk.createConversationBridge, 'function');
  assert.equal(hash(readFileSync(join(path, 'dist/owner/font.otf'))), plan.output_sha256);
  assert.equal(hash(readFileSync(join(path, 'dist/owner/renderer.wasm'))), '22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70');
});

test('build follows side-effect imports, re-exports, cycles, literal dynamic imports and new nested SDK entries', async t => {
  const path = fixture(t);
  appendFileSync(join(path, 'src/owner/worker.js'), `
    import './feature/side-effect.mjs';
    export {value} from './feature/barrel.mjs';
    export * as namespace from './feature/leaf.mjs';
    export const lazy = () => import('./feature/lazy.mjs');
    export const templateLazy = () => import(\`./feature/template-lazy.mjs\`);
    // import('./not-a-real-import.mjs')
    const text = "export * from './not-a-real-export.mjs'";
    const html = \`<script>import('./not-a-real-html-import.mjs')</script>\`;
  `);
  put(path, 'src/owner/feature/side-effect.mjs', 'export {};');
  put(path, 'src/owner/feature/barrel.mjs', 'export * from "./leaf.mjs";');
  put(path, 'src/owner/feature/leaf.mjs', 'import "./barrel.mjs"; export const value = 42;');
  put(path, 'src/owner/feature/lazy.mjs', 'export {value} from "./leaf.mjs";');
  put(path, 'src/owner/feature/template-lazy.mjs', 'export {value} from "./leaf.mjs";');
  put(path, 'src/sdk/nested/future.mjs', 'export const load = () => import("../../owner/feature/lazy.mjs");');
  put(path, 'dist/owner/obsolete.mjs', 'stale output must disappear');
  put(path, 'dist/showcase/obsolete.html', 'the entire dist is generated');
  const result = build(path);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(path, 'dist/owner/obsolete.mjs')), false);
  assert.equal(existsSync(join(path, 'dist/showcase/obsolete.html')), false);
  linkEntries(path, ['owner/worker.js', 'gateway/worker.mjs', 'sdk/example.mjs', 'sdk/nested/future.mjs']);
  const sdk = await import(pathToFileURL(join(path, 'dist/sdk/nested/future.mjs')).href);
  assert.equal((await sdk.load()).value, 42);
  assert.equal((await import(pathToFileURL(join(path, 'dist/owner/feature/template-lazy.mjs')).href)).value, 42);
});

for (const [name, source] of [
  ['static import', 'import {missing} from "./missing.mjs";'],
  ['side-effect import', 'import "./missing.mjs";'],
  ['named re-export', 'export {missing} from "./missing.mjs";'],
  ['star re-export', 'export * from "./missing.mjs";'],
  ['literal dynamic import', 'export const load = () => import("./missing.mjs");'],
  ['template literal dynamic import', 'export const load = () => import(`./missing.mjs`);'],
]) {
  test(`build fails on unresolved ${name} even when stale dist contains that file`, t => {
    const path = fixture(t);
    appendFileSync(join(path, 'src/owner/worker.js'), source);
    put(path, 'dist/owner/missing.mjs', 'export const missing = true;');
    const result = build(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unresolved module owner\/missing\.mjs/);
    assert.equal(readFileSync(join(path, 'dist/owner/missing.mjs'), 'utf8'), 'export const missing = true;');
    assert.equal(readdirSync(path).some(name => name.startsWith('.dist-build-')), false);
  });
}

for (const source of [
  'export const load = name => import(name);',
  'export const load = name => import(`./${name}.mjs`);',
  'export const load = () => import("./" + "module.mjs");',
]) {
  test(`build rejects unprovable dynamic import: ${source}`, t => {
    const path = fixture(t);
    appendFileSync(join(path, 'src/owner/worker.js'), source);
    const result = build(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Non-literal dynamic import cannot be verified/);
    assert.equal(existsSync(join(path, 'dist')), false);
  });
}

test('build rejects SDK dependencies escaping src and unknown runtime/package imports', async t => {
  for (const [specifier, expected] of [['../../outside.mjs', /escapes the source\/output root/], ['missing-package', /Unresolved external module/]]) {
    await t.test(specifier, t => {
      const path = fixture(t);
      put(path, 'outside.mjs', 'export const secret = true;');
      put(path, 'src/sdk/example.mjs', `import ${JSON.stringify(specifier)};`);
      const result = build(path);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    });
  }
});

test('missing entry points and syntax errors cannot produce a successful build', async t => {
  for (const [entry, expected] of [['src/owner/worker.js', /Unresolved module owner\/worker\.js/], ['src/gateway/worker.mjs', /Unresolved module gateway\/worker\.mjs/]]) {
    await t.test(entry, t => {
      const path = fixture(t);
      rmSync(join(path, entry));
      const result = build(path);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    });
  }
  await t.test('malformed SDK', t => {
    const path = fixture(t);
    put(path, 'src/sdk/example.mjs', 'export const broken = ;');
    const result = build(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sdk\/example\.mjs: Expression expected/);
  });
});

test('pinned font and WASM hashes remain mandatory before replacing any dist output', async t => {
  for (const [name, label] of [['assets/font.otf', 'Noto font'], ['node_modules/@resvg/resvg-wasm/index_bg.wasm', 'resvg WASM']]) {
    await t.test(label, t => {
      const path = fixture(t);
      put(path, name, 'corrupted resource');
      put(path, 'dist/previous-build.txt', 'keep prior verified output');
      const result = build(path);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(label + ' integrity mismatch'));
      assert.equal(readFileSync(join(path, 'dist/previous-build.txt'), 'utf8'), 'keep prior verified output');
    });
  }
});
