import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentHash, isPathInside, posix, satisfies, sha256 } from './common.mjs';
import { isValidStackName } from './stacks.mjs';
import { templateIssues } from './template-compat.mjs';

export class StackPackError extends Error {
  constructor(message, code = 'STACK_PACK') {
    super(message);
    this.name = 'StackPackError';
    this.code = code;
  }
}

export const PACK_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  packBytes: 10 * 1024 * 1024,
  files: 500,
});

const URL_PATTERN = /^(https:\/\/|ssh:\/\/|git@[^:]+:)/i;
const LOCAL_PATTERN = /^(file:\/\/|[A-Za-z]:[\\/]|\/)/;

export function normalizeRepoUrl(input, { allowFile = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new StackPackError('仓库 URL 不能为空', 'STACK_URL');
  if (raw.startsWith('-') || /^(ext|transport)::/i.test(raw)) {
    throw new StackPackError(`不安全的仓库 URL：${raw}`, 'STACK_URL');
  }
  if (allowFile && LOCAL_PATTERN.test(raw)) {
    if (raw.includes('..')) throw new StackPackError(`仓库路径不能包含 ..：${raw}`, 'STACK_URL');
    return raw.replace(/\\/g, '/');
  }
  if (raw.startsWith('file://')) {
    throw new StackPackError('file:// 只能用于 --from 本地目录，不能作为可提交来源', 'STACK_URL');
  }
  if (!URL_PATTERN.test(raw)) {
    throw new StackPackError(`仓库 URL 只允许 https://、ssh:// 或 git@host:：${raw}`, 'STACK_URL');
  }
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new StackPackError(`仓库 URL 无法解析：${raw}`, 'STACK_URL');
    }
    if (url.username || url.password) {
      throw new StackPackError('仓库 URL 不能包含用户名或密码', 'STACK_URL');
    }
  }
  // git@host: 的 git 用户是 SSH 语法的一部分；这里只拒绝真正内嵌的密码。
  if (/^ssh:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new StackPackError(`仓库 URL 无法解析：${raw}`, 'STACK_URL');
    }
    if (url.password) {
      throw new StackPackError('仓库 URL 不能包含密码', 'STACK_URL');
    }
  }
  return raw.replace(/\/+$/, '');
}

export function repoCacheId(url, opts = {}) {
  return sha256(normalizeRepoUrl(url, opts)).slice(0, 12);
}

function readJsonFile(file, label) {
  if (!existsSync(file)) throw new StackPackError(`缺少 ${label}：${posix(file)}`, 'STACK_JSON');
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new StackPackError(`${label} 不是合法 JSON：${err.message}`, 'STACK_JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new StackPackError(`${label} 必须是 JSON 对象`, 'STACK_JSON');
  }
  return data;
}

export function readIndex(rootDir) {
  return validateIndex(readJsonFile(join(rootDir, 'index.json'), 'index.json'));
}

/** 本地目录与远程 `index.json` 共用同一套校验。 */
export function validateIndex(data) {
  if (data.schemaVersion !== 1) {
    throw new StackPackError(`index.json 的 schemaVersion 必须是 1，当前为 ${data.schemaVersion}`, 'STACK_INDEX');
  }
  if (!data.packs || typeof data.packs !== 'object' || Array.isArray(data.packs)) {
    throw new StackPackError('index.json 的 packs 必须是对象', 'STACK_INDEX');
  }
  for (const [packId, entry] of Object.entries(data.packs)) {
    if (!isValidStackName(packId)) {
      throw new StackPackError(`index.json 含非法包名：${packId}`, 'STACK_INDEX');
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new StackPackError(`index.json 的 ${packId} 必须是对象`, 'STACK_INDEX');
    }
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new StackPackError(`index.json 的 ${packId} 缺少 path`, 'STACK_INDEX');
    }
    if (!Array.isArray(entry.detects)) {
      throw new StackPackError(`index.json 的 ${packId}.detects 必须是数组`, 'STACK_INDEX');
    }
  }
  return data;
}

export function resolveIndexPack(index, packId, rootDir) {
  const entry = index.packs[packId];
  if (!entry) throw new StackPackError(`index.json 中不存在包：${packId}`, 'STACK_INDEX');
  const packDir = resolve(rootDir, entry.path);
  if (!isPathInside(rootDir, packDir)) {
    throw new StackPackError(`包路径越界：${packId} → ${entry.path}`, 'STACK_INDEX');
  }
  if (!existsSync(packDir)) {
    throw new StackPackError(`包目录不存在：${posix(packDir)}`, 'STACK_INDEX');
  }
  return { packId, entry, packDir };
}
