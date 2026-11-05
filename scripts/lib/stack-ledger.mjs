import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseYaml, posix, readText, withFileLock, writeAtomic,
} from './common.mjs';
import { StackPackError } from './stack-pack.mjs';

export const STACK_SOURCES_FILE = '.claude/.stack-sources.json';
export const STACK_LOCK_FILE = '.claude/hub/stack-lock.yaml';

export function stackPaths(root) {
  const claude = join(root, '.claude');
  return {
    sources: join(root, ...STACK_SOURCES_FILE.split('/')),
    lock: join(root, ...STACK_LOCK_FILE.split('/')),
    basesRoot: join(claude, '.stack-bases'),
    stagingRoot: join(claude, '.stack-staging'),
    trashRoot: join(claude, '.stack-trash'),
    stackDir: (name) => join(claude, 'hub', 'stacks', name),
    basesDir: (name) => join(claude, '.stack-bases', name),
  };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readSources(root) {
  const { sources } = stackPaths(root);
  if (!existsSync(sources)) return { schemaVersion: 1, packs: {} };
  let data;
  try {
    data = JSON.parse(readText(sources));
  } catch {
    // 不拼接 V8 的解析消息：它可能回显文件片段。
    throw new StackPackError(`安装账本损坏：${posix(sources)}；运行 devflow stack status 或 doctor`, 'STACK_LEDGER');
  }
  if (!plainObject(data) || data.schemaVersion !== 1 || !plainObject(data.packs)) {
    throw new StackPackError(`安装账本格式不支持：${posix(sources)}`, 'STACK_LEDGER');
  }
  for (const [key, record] of Object.entries(data.packs)) {
    if (!plainObject(record) || record.installedAs !== key) {
      throw new StackPackError(`安装账本记录不一致：${key}`, 'STACK_LEDGER');
    }
    if (!['git', 'local'].includes(record.source)) {
      throw new StackPackError(`安装账本缺少来源类型：${key}`, 'STACK_LEDGER');
    }
  }
  return data;
}

export function writeSources(root, sources) {
  const file = stackPaths(root).sources;
  withFileLock(file, () => {
    writeAtomic(file, `${JSON.stringify(sources, null, 2)}\n`);
  }, { failClosed: true });
}

export function readLock(root) {
  const file = stackPaths(root).lock;
  if (!existsSync(file)) return { version: 1, packs: {} };
  let data;
  try {
    data = parseYaml(readText(file));
  } catch {
    // 不拼接解析器的原始消息：它可能回显文件片段。
    throw new StackPackError(`stack-lock.yaml 解析失败：${posix(file)}`, 'STACK_LOCK');
  }
  if (!plainObject(data) || Number(data.version) !== 1 || !plainObject(data.packs || {})) {
    throw new StackPackError('stack-lock.yaml 格式不支持', 'STACK_LOCK');
  }
  return { ...data, version: 1, packs: data.packs || {} };
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

export function renderLockYaml(lock) {
  const lines = [`version: ${Number(lock.version) || 1}`, 'packs:'];
  for (const [key, record] of Object.entries(lock.packs || {})) {
    lines.push(`  ${key}:`);
    for (const field of ['installedAs', 'repo', 'packId', 'path', 'ref', 'commit', 'version']) {
      if (record[field] !== undefined && record[field] !== null) {
        lines.push(`    ${field}: ${yamlScalar(record[field])}`);
      }
    }
  }
  for (const [key, value] of Object.entries(lock)) {
    if (key === 'version' || key === 'packs') continue;
    lines.push(`${key}: ${typeof value === 'object' && value !== null ? yamlScalar(JSON.stringify(value)) : yamlScalar(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeLock(root, lock) {
  const file = stackPaths(root).lock;
  withFileLock(file, () => {
    writeAtomic(file, renderLockYaml(lock));
  }, { failClosed: true });
}

export function managedStackPrefixes(sources) {
  return Object.values(sources.packs || {}).map((record) => `.claude/hub/stacks/${record.installedAs}/`);
}

export function managedStackNames(sources) {
  return new Set(Object.values(sources.packs || {}).map((record) => record.installedAs));
}

/** pack 接管目录后，模板库不再保留同一目录的同步基线。 */
export function dropHubOwnership(root, installedAs) {
  const file = join(root, '.claude', '.hub-sources.json');
  if (existsSync(file)) {
    let data = null;
    try {
      data = JSON.parse(readText(file));
    } catch {
      data = null;
    }
    if (plainObject(data) && plainObject(data.files)) {
      const prefix = `.claude/hub/stacks/${installedAs}/`;
      for (const rel of Object.keys(data.files)) {
        if (rel.startsWith(prefix)) delete data.files[rel];
      }
      writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    }
  }
  const baseDir = join(root, '.claude', '.hub-bases', 'stacks', installedAs);
  rmSync(baseDir, { recursive: true, force: true });
}
