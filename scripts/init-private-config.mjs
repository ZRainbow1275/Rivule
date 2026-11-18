// Initialize local Rivule configs. Never read, replace or chmod an existing config.
import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = fileURLToPath(new URL('../config/', import.meta.url));
const names = ['owner', 'qq'];

function alreadyPresent(path, label) {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current) return false;
  if (!current.isFile()) throw new Error(`${label} 已存在但不是普通文件；保持原样，请自行核对。`);
  return true;
}

function prepare(name) {
  const label = `config/wrangler.${name}.private.json`;
  const path = join(config, `wrangler.${name}.private.json`);
  if (alreadyPresent(path, label)) return { path, label, present: true };
  const example = `wrangler.${name}.example.json`;
  if (!lstatSync(join(config, example), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`找不到普通模板文件 config/${example}；未建立任何文件。`);
  }
  const bytes = readFileSync(join(config, example));
  try { JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error(`模板 config/${example} 不是有效 JSON；未建立任何文件。`);
  }
  return { path, label, bytes, present: false };
}

function main() {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
      console.log('用法：node scripts/init-private-config.mjs\n只在缺少 owner 或 QQ 私人配置时建立本地文件，保留已有文件。不部署。');
      return;
    }
    throw new Error('不支持此参数；未建立任何文件。使用 --help 查看用法。');
  }
  // Check both destinations and all needed inputs before publishing either file.
  const plans = names.map(prepare);
  let stage;
  try {
    if (plans.some(plan => !plan.present)) stage = mkdtempSync(join(config, '.rivule-init-'));
    for (const [i, plan] of plans.entries()) {
      if (!plan.present) {
        const ready = join(stage, String(i));
        writeFileSync(ready, plan.bytes, { flag: 'wx', mode: 0o600 });
        try {
          // Publish a complete file without replacing an existing directory entry.
          // Staging under config/ keeps both paths on the same filesystem.
          linkSync(ready, plan.path);
        } catch (error) {
          if (error.code !== 'EEXIST' || !alreadyPresent(plan.path, plan.label)) {
            const code = error.code || 'I/O';
            throw new Error(`无法独占建立 ${plan.label}（${code}）。请检查本地目录及文件系统支持，不要覆盖现有文件。`);
          }
          plan.present = true; // Another initializer finished this file first.
        }
      }
      console.log(`${plan.present ? '已保留' : '已建立'} ${plan.label}`);
    }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

try { main(); } catch (error) {
  console.error(`私人配置初始化未完成：${error.message}`);
  process.exitCode = 1;
}
