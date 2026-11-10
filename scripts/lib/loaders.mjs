/**
 * 项目侧薄 loader 清单：项目 `scripts/devflow-*.mjs` 只负责转发到插件实现。
 * init 写入、doctor 校验、sync 兼容性检查共用这一份清单，避免三处漂移。
 */
export const LOADERS = {
  'devflow-gen.mjs': 'gen-claude-skills',
  'devflow-doctor.mjs': 'hub-doctor',
  'devflow-route.mjs': 'hub-route',
  'devflow-upstream.mjs': 'hub-upstream',
  'devflow-test.mjs': 'mark-test',
  'devflow-triage.mjs': 'review-triage',
  'devflow-check.mjs': 'stage-check',
  'devflow-trace.mjs': 'trace',
  'devflow-stack.mjs': 'hub-stack',
  'devflow-clean.mjs': 'hub-clean',
};

export function loaderSource(name) {
  return `#!/usr/bin/env node
// devflow 薄 loader：真实实现在插件内，避免项目里出现第二份脚本。
// 插件升级后 .devflow.json 记录的旧缓存可能失效，此时优先使用当前会话的 CLAUDE_PLUGIN_ROOT，再回退到源码仓库。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let meta = {};
try { meta = JSON.parse(readFileSync(join(root, '.devflow.json'), 'utf8')); } catch { meta = {}; }

const candidates = [process.env.CLAUDE_PLUGIN_ROOT, meta.pluginRoot, meta.pluginSourceRoot]
  .filter(Boolean)
  .filter((dir, i, all) => all.indexOf(dir) === i);
let mod = null;
let lastError = null;
for (const dir of candidates) {
  const entry = join(dir, 'scripts', '${name}.mjs');
  if (!existsSync(entry)) { lastError = new Error('缺少 ' + entry); continue; }
  try {
    mod = await import(pathToFileURL(entry).href);
    break;
  } catch (err) { lastError = err; }
}
if (!mod) {
  console.error('[ERR] 找不到可用的 devflow 插件目录。请检查 CLAUDE_PLUGIN_ROOT，或重新运行 /devflow:init。'
    + (lastError ? ' 最后一次错误：' + lastError.message : ''));
  process.exit(1);
}
await mod.main(process.argv.slice(2));
`;
}
