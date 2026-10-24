import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, statSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const moduleExtensions = new Set(['.js', '.mjs']);
// These are provided by workerd, not files to omit silently from the graph.
const runtimeModules = new Set(['cloudflare:workers']);
const resourceFiles = new Set(['owner/font.otf', 'owner/renderer.wasm']);
const wasmSha256 = '22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70';

function verify(path, expected, label) {
  let bytes;
  try { bytes = readFileSync(path); }
  catch { throw Error(label + ' missing. Run npm ci --ignore-scripts and npm run resources before building.'); }
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw Error(label + ' integrity mismatch. Restore the pinned resource; build stopped.');
  return bytes;
}

function inside(directory, path) {
  const name = relative(directory, path);
  return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
}

function sdkEntries(directory, prefix = 'sdk') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) return sdkEntries(join(directory, entry.name), name);
    if (entry.isSymbolicLink()) throw Error('SDK source symlinks are not supported: ' + name);
    return moduleExtensions.has(extname(entry.name)) ? [name] : [];
  });
}

function moduleSpecifiers(bytes, name) {
  const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fail = (node, message) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    throw Error(`${name}:${line + 1}:${character + 1}: ${message}`);
  };
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0];
    throw Error(`${name}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }
  const specifiers = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) fail(node, 'Module specifier must be a string literal.');
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (!specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)))
        fail(node, 'Non-literal dynamic import cannot be verified; use a literal module specifier.');
      specifiers.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function collectGraph(directory, entries, generated = new Map()) {
  const base = resolve(directory);
  const realBase = realpathSync(base);
  const files = new Map();
  function visit(path, importer = 'entry point') {
    if (!inside(base, path)) throw Error(`${importer}: Module escapes the source/output root: ${path}`);
    const name = relative(base, path);
    if (files.has(name)) return;
    let bytes = generated.get(name);
    if (!bytes) {
      try {
        if (!statSync(path).isFile()) throw Error('not a file');
        if (!inside(realBase, realpathSync(path))) throw Error('source symlink escapes the root');
        bytes = readFileSync(path);
      } catch (error) { throw Error(`${importer}: Unresolved module ${name}: ${error.message}`); }
    }
    // Register before following edges so cyclic imports terminate normally.
    files.set(name, bytes);
    if (!moduleExtensions.has(extname(name))) {
      if (!resourceFiles.has(name)) throw Error(`${importer}: Unsupported module/resource type: ${name}`);
      return;
    }
    for (const specifier of moduleSpecifiers(bytes, name)) {
      if (runtimeModules.has(specifier)) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../'))
        throw Error(`${name}: Unresolved external module ${JSON.stringify(specifier)}; this no-bundle build only externalizes cloudflare:workers.`);
      if (specifier.includes('\\')) throw Error(`${name}: Backslashes in module specifiers are not supported.`);
      const url = new URL(specifier, pathToFileURL(path));
      if (url.search || url.hash) throw Error(`${name}: Query/fragment module specifiers are not supported: ${specifier}`);
      visit(fileURLToPath(url), name);
    }
  }
  for (const entry of entries) visit(resolve(base, entry));
  return files;
}

const plan = JSON.parse(readFileSync(new URL('font-repack.json', import.meta.url)));
const font = verify(join(root, plan.output_path), plan.output_sha256, 'Noto font');
let wasmPath;
try { wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm'); }
catch { throw Error('resvg WASM missing. Run npm ci --ignore-scripts before building.'); }
const wasm = verify(wasmPath, wasmSha256, 'resvg WASM');
const generated = new Map([['owner/font.otf', font], ['owner/renderer.wasm', wasm]]);
const entries = ['owner/worker.js', 'gateway/worker.mjs', ...sdkEntries(join(root, 'src/sdk'))];
const graph = collectGraph(join(root, 'src'), entries, generated);
for (const [name, bytes] of generated) graph.set(name, bytes);

// Validate a fresh tree before replacing dist: stale output cannot satisfy an import.
const staging = mkdtempSync(join(root, '.dist-build-'));
try {
  for (const [name, bytes] of graph) {
    const target = join(staging, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const outputGraph = collectGraph(staging, [...entries, ...generated.keys()]);
  for (const [name, bytes] of graph) {
    if (!outputGraph.get(name)?.equals(bytes)) throw Error('Built file differs from verified source: ' + name);
  }
  if (outputGraph.size !== graph.size) throw Error('Unexpected dependency in built module graph.');
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  renameSync(staging, join(root, 'dist'));
  console.log(`Built owner, gateway and SDK import closure (${entries.length} entries, ${graph.size} files) in fresh dist/.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
