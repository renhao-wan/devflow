import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRealPathInside, isValidStageName, posix, walk } from './common.mjs';

export const STACK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidStackName(name) {
  return STACK_NAME_RE.test(String(name));
}

export function stackDir(root, name) {
  if (!isValidStackName(name)) return null;
  return join(root, '.claude', 'hub', 'stacks', String(name));
}

function declaredStack(value) {
  if (value == null) return { name: null, invalid: false };
  if (typeof value !== 'string') return { name: null, invalid: true };
  const name = value.trim();
  return { name: name || null, invalid: false };
}

function fileInStack(root, name, dir, rel) {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return null;
  if (!statSync(abs).isFile()) return { error: `不是文件：${posix(abs)}` };
  if (!isRealPathInside(root, abs)) return { error: `真实路径越出项目：${posix(abs)}` };
  return { path: posix(join('.claude', 'hub', 'stacks', name, ...rel.split(/[\\/]/))) };
}

function inspectStack(root, name, stages) {
  const dir = stackDir(root, name);
  const summary = { name, dir: null, shared: null, stages: {} };
  const issues = [];
  if (!dir) {
    issues.push({ severity: 'error', message: `技术栈名非法：${name}。只允许 [a-z0-9][a-z0-9_-]*。` });
    return { summary, issues, dirExists: false, stageFiles: {}, sharedFile: null, invalidName: true };
  }
  summary.dir = `.claude/hub/stacks/${name}`;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    issues.push({
      severity: 'error',
      message: `技术栈目录不存在：${summary.dir}。运行 /devflow:sync，或检查 hub.yaml 的 stack 声明。`,
    });
    return { summary, issues, dirExists: false, stageFiles: {}, sharedFile: null };
  }
  if (!isRealPathInside(root, dir)) {
    issues.push({ severity: 'error', message: `技术栈目录真实路径越出项目：${summary.dir}。` });
    return { summary, issues, dirExists: false, stageFiles: {}, sharedFile: null };
  }

  const shared = fileInStack(root, name, dir, '_shared.md');
  if (shared?.error) issues.push({ severity: 'error', message: `${summary.dir}/_shared.md：${shared.error}` });
  else if (shared?.path) summary.shared = shared.path;

  const stageFiles = {};
  for (const stage of stages) {
    if (!isValidStageName(stage)) continue;
    const found = fileInStack(root, name, dir, `${stage}.md`);
    if (found?.error) issues.push({ severity: 'error', message: `${summary.dir}/${stage}.md：${found.error}` });
    else if (found?.path) {
      stageFiles[stage] = found.path;
      summary.stages[stage] = found.path;
    }
  }

  if (!walk(dir, '.md').length) {
    issues.push({
      severity: 'warn',
      message: `技术栈目录没有 .md 规则：${summary.dir}。可添加 _shared.md 或 <stage>.md。`,
    });
  }

  return { summary, issues, dirExists: true, stageFiles, sharedFile: summary.shared };
}

/**
 * 把 hub.yaml 的 stack 声明映射成当前阶段的读取表。
 * 投影只记录路径，不内联正文；内容变化不需要重新生成。
 */
export function planStacks(root, config = {}, stages = []) {
  const rows = [];
  const issues = [];
  const inspectedByName = new Map();
  const subs = config?.subprojects && typeof config.subprojects === 'object' && !Array.isArray(config.subprojects)
    ? config.subprojects
    : {};
  const rootStack = declaredStack(config?.stack);
  if (rootStack.invalid) {
    issues.push({ severity: 'error', message: 'hub.yaml 的顶层 stack 必须是字符串。' });
  }

  const inspectOnce = (name) => {
    if (!inspectedByName.has(name)) {
      const inspected = inspectStack(root, name, stages);
      inspectedByName.set(name, inspected);
      issues.push(...inspected.issues);
    }
    return inspectedByName.get(name);
  };

  const addRow = (subproject, path, declared) => {
    if (!declared.name) return;
    const inspected = inspectOnce(declared.name);
    rows.push({
      subproject,
      path,
      stack: declared.name,
      dir: inspected.summary.dir || `.claude/hub/stacks/${declared.name}`,
      dirExists: inspected.dirExists,
      invalidName: inspected.invalidName === true,
      stageFile: inspected.stageFiles,
      sharedFile: inspected.sharedFile,
    });
  };

  const subEntries = Object.entries(subs);
  if (!subEntries.length) {
    addRow('（工作区根）', '.', rootStack);
  } else {
    for (const [name, value] of subEntries) {
      const own = declaredStack(value?.stack);
      if (own.invalid) {
        issues.push({ severity: 'error', message: `子项目 ${name} 的 stack 必须是字符串。` });
      }
      const declared = own.name ? own : rootStack;
      addRow(name, value?.path || name, declared);
    }
  }

  return {
    rows,
    stacks: [...inspectedByName.values()].map((item) => item.summary),
    issues,
  };
}
