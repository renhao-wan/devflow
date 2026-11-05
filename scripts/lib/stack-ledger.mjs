import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, posix, readText, withFileLock, writeAtomic } from './common.mjs';
import { isValidStackName } from './stacks.mjs';
import { StackPackError } from './stack-pack.mjs';

export const STACK_SOURCES_FILE = '.claude/.stack-sources.json';
export const STACK_LOCK_FILE = '.claude/hub/stack-lock.yaml';

/** readLock 解析出的未知顶层字段原文，非枚举，避免污染账本数据。 */
const LOCK_RAW_FIELDS = Symbol('stackLockRawFields');

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

const LEDGER_HINT = '；运行 devflow stack status 或 doctor';

export function readSources(root) {
  const { sources } = stackPaths(root);
  if (!existsSync(sources)) return { schemaVersion: 1, packs: {} };
  let text;
  try {
    text = readText(sources);
  } catch {
    throw new StackPackError(`安装账本无法读取：${posix(sources)}${LEDGER_HINT}`, 'STACK_LEDGER');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 不拼接 V8 的解析消息：它可能回显文件片段。
    throw new StackPackError(`安装账本损坏：${posix(sources)}${LEDGER_HINT}`, 'STACK_LEDGER');
  }
  if (!plainObject(data) || data.schemaVersion !== 1 || !plainObject(data.packs)) {
    throw new StackPackError(`安装账本格式不支持：${posix(sources)}${LEDGER_HINT}`, 'STACK_LEDGER');
  }
  for (const [key, record] of Object.entries(data.packs)) {
    // 键会参与目录拼接，必须先过栈名校验；错误消息不回显 key，避免日志注入。
    if (!isValidStackName(key)) {
      throw new StackPackError(`安装账本包含非法栈名：${posix(sources)}${LEDGER_HINT}`, 'STACK_LEDGER');
    }
    if (!plainObject(record) || record.installedAs !== key) {
      throw new StackPackError(`安装账本记录不一致：${posix(sources)}${LEDGER_HINT}`, 'STACK_LEDGER');
    }
    if (!['git', 'local'].includes(record.source)) {
      throw new StackPackError(`安装账本记录缺少来源类型：${posix(sources)}${LEDGER_HINT}`, 'STACK_LEDGER');
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

function unquoteKey(value) {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/** 按顶层键切出原始文本块，供未知字段无损写回。 */
function rawTopLevelFields(text) {
  const blocks = new Map();
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) {
      while (buffer.length && buffer[buffer.length - 1].trim() === '') buffer.pop();
      if (buffer.length) blocks.set(current, buffer.join('\n'));
    }
    current = null;
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const indent = /^ */.exec(line)[0].length;
    const trimmed = line.trim();
    if (indent === 0 && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('- ')) {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (m) {
        flush();
        current = unquoteKey(m[1]);
        buffer = [line];
        continue;
      }
    }
    if (current) buffer.push(line);
  }
  flush();
  return blocks;
}

function badLock(message) {
  return new StackPackError(`stack-lock.yaml ${message}`, 'STACK_LOCK');
}

export function readLock(root) {
  const file = stackPaths(root).lock;
  if (!existsSync(file)) return { version: 1, packs: {} };
  let text;
  try {
    text = readText(file);
  } catch {
    throw badLock(`无法读取：${posix(file)}`);
  }
  let data;
  try {
    data = parseYaml(text);
  } catch {
    // 不拼接解析器的原始消息：它可能回显文件片段。
    throw badLock(`解析失败：${posix(file)}`);
  }
  if (!plainObject(data) || Number(data.version) !== 1) {
    throw badLock(`格式不支持：${posix(file)}`);
  }
  let packs;
  if (data.packs == null) packs = {};
  else if (plainObject(data.packs)) packs = data.packs;
  else throw badLock(`格式不支持：${posix(file)}`);
  for (const [key, record] of Object.entries(packs)) {
    // key 会参与目录拼接；非法键直接拒绝，错误消息不回显键名，避免日志注入。
    if (!isValidStackName(key)) {
      throw badLock('包含非法栈名');
    }
    if (!plainObject(record) || record.installedAs !== key) {
      throw badLock(`记录与栈名不一致：${posix(file)}`);
    }
  }
  const raw = rawTopLevelFields(text);
  const unknown = new Map();
  for (const [key, block] of raw) {
    if (key !== 'version' && key !== 'packs') unknown.set(key, block);
  }
  const result = { ...data, version: 1, packs };
  Object.defineProperty(result, LOCK_RAW_FIELDS, { value: unknown });
  return result;
}

function losslessError(message) {
  return new StackPackError(`stack-lock.yaml 无法无损写入${message}`, 'STACK_LOCK');
}

function yamlString(value) {
  if (/[\r\n]/.test(value)) throw losslessError('：字符串包含换行');
  if (value.includes("'") && value.includes('"')) throw losslessError('：字符串同时包含单双引号');
  // 解析器会先去掉引号再识别类型，这类字符串无法仅靠引号保持字符串语义。
  if (/^(true|false|null|~|-?\d+)$/.test(value) || /^[\[{]/.test(value)) {
    throw losslessError('：字符串会被解析成其他类型');
  }
  if (!value.includes("'")) return `'${value}'`;
  return `"${value}"`;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw losslessError('：数字不是有限值');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return yamlString(value);
  throw losslessError(`：不支持 ${typeof value} 类型的值`);
}

function yamlKey(key) {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw losslessError('：字段名包含不安全字符');
  return key;
}

function renderYamlField(key, value, indent, lines) {
  const pad = ' '.repeat(indent);
  const name = yamlKey(key);
  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${pad}${name}: []`);
      return;
    }
    lines.push(`${pad}${name}:`);
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        throw losslessError('：数组只能包含标量');
      }
      lines.push(`${pad}  - ${yamlScalar(item)}`);
    }
    return;
  }
  if (plainObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) {
      lines.push(`${pad}${name}: {}`);
      return;
    }
    lines.push(`${pad}${name}:`);
    for (const [childKey, childValue] of entries) {
      renderYamlField(childKey, childValue, indent + 2, lines);
    }
    return;
  }
  lines.push(`${pad}${name}: ${yamlScalar(value)}`);
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
  const raw = lock[LOCK_RAW_FIELDS];
  for (const [key, value] of Object.entries(lock)) {
    if (key === 'version' || key === 'packs') continue;
    if (raw && raw.has(key)) {
      lines.push(raw.get(key));
    } else {
      renderYamlField(key, value, 0, lines);
    }
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

/** pack 接管目录后，模板库不再保留同一目录的同步基线；失败只降级为 warning。 */
export function dropHubOwnership(root, installedAs) {
  const warnings = [];
  if (!isValidStackName(installedAs)) {
    warnings.push(`拒绝转移非法栈名的所有权：${installedAs}`);
    return warnings;
  }
  const file = join(root, '.claude', '.hub-sources.json');
  if (existsSync(file)) {
    let data;
    let readable = true;
    try {
      data = JSON.parse(readText(file));
    } catch {
      readable = false;
    }
    if (!readable) {
      warnings.push(`.hub-sources.json 无法读取或解析：${posix(file)}`);
    } else if (!plainObject(data) || !plainObject(data.files)) {
      warnings.push(`.hub-sources.json 格式不支持：${posix(file)}`);
    } else {
      const prefix = `.claude/hub/stacks/${installedAs}/`;
      let changed = false;
      for (const rel of Object.keys(data.files)) {
        if (rel.startsWith(prefix)) {
          delete data.files[rel];
          changed = true;
        }
      }
      if (changed) {
        try {
          writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
        } catch {
          // 不拼接异常原文：它可能回显路径之外的敏感信息。
          warnings.push(`.hub-sources.json 无法写入：${posix(file)}`);
        }
      }
    }
  }
  const baseDir = join(root, '.claude', '.hub-bases', 'stacks', installedAs);
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    warnings.push(`无法删除旧基线：${posix(baseDir)}`);
  }
  return warnings;
}
