import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
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
    throw new StackPackError('不安全的仓库 URL', 'STACK_URL');
  }
  if (allowFile && LOCAL_PATTERN.test(raw)) {
    if (raw.includes('..')) throw new StackPackError('仓库路径不能包含 ..', 'STACK_URL');
    return raw.replace(/\\/g, '/');
  }
  if (raw.startsWith('file://')) {
    throw new StackPackError('file:// 只能用于 --from 本地目录，不能作为可提交来源', 'STACK_URL');
  }
  if (!URL_PATTERN.test(raw)) {
    throw new StackPackError('仓库 URL 只允许 https://、ssh:// 或 git@host:', 'STACK_URL');
  }
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new StackPackError('仓库 URL 无法解析', 'STACK_URL');
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
      throw new StackPackError('仓库 URL 无法解析', 'STACK_URL');
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

const ROOT_MD = /^[A-Za-z0-9._-]+\.md$/;
const REF_MD = /^references\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const DANGEROUS = [
  { re: /(curl|wget)[^\n|]*\|\s*(sh|bash|zsh|powershell|pwsh)\b/i, message: '包含从网络直接执行的命令' },
  { re: /\brm\s+-rf\s+[^\n]*(\/|~|\$HOME|\*)/i, message: '包含高风险删除命令' },
  { re: /(\.ssh\/id_rsa|\.aws\/credentials|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)/i, message: '提到敏感凭据路径或变量' },
];

/** 扫描正文里的高风险指令片段；只返回原因，由调用方降级为警告而不是拒绝。 */
export function scanDangerous(text) {
  return DANGEROUS.filter((item) => item.re.test(String(text))).map((item) => item.message);
}

/** 递归列出包内文件；符号链接与特殊文件一律拒绝，避免读取包目录之外的路径。 */
function listPackFiles(dir) {
  const out = [];
  const visit = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        throw new StackPackError(`包内不允许符号链接：${childRel}`, 'STACK_PATH');
      }
      if (st.isDirectory()) {
        visit(childAbs, childRel);
      } else if (st.isFile()) {
        out.push({ abs: childAbs, rel: childRel, size: st.size });
      } else {
        throw new StackPackError(`包内不允许特殊文件：${childRel}`, 'STACK_PATH');
      }
    }
  };
  visit(dir, '');
  return out;
}

/** 读成文本后按 UTF-8 回编码比对，非法字节会被替换字符破坏，从而识别非 UTF-8 文件。 */
function readUtf8(file, rel) {
  const buf = readFileSync(file);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throw new StackPackError(`不是 UTF-8 文本：${rel}`, 'STACK_ENCODING');
  }
  return text;
}

/**
 * 读取并校验一个包目录：白名单、大小、UTF-8、哈希、兼容性。
 * 返回值中的 files 已按 rel 排序；危险指令与兼容性提示放在 warnings，错误直接抛 StackPackError。
 */
export function readPackFromDir(dir, {
  packId = null, indexEntry = null, loaderFiles = null, pluginVersion = null,
} = {}) {
  const stackFile = join(dir, 'stack.json');
  if (!existsSync(stackFile)) throw new StackPackError(`包目录缺少 stack.json：${posix(dir)}`, 'STACK_PACK');
  const listed = listPackFiles(dir);
  if (listed.length > PACK_LIMITS.files) {
    throw new StackPackError(`包内文件超过 ${PACK_LIMITS.files} 个`, 'STACK_SIZE');
  }

  const seen = new Set();
  let total = 0;
  const contents = new Map();
  for (const item of listed) {
    if (item.rel !== 'stack.json' && !ROOT_MD.test(item.rel) && !REF_MD.test(item.rel)) {
      throw new StackPackError(`不允许的文件：${item.rel}`, 'STACK_PATH');
    }
    // 大小写不敏感文件系统上，仅大小写不同的两个路径会互相覆盖。
    const lower = item.rel.toLowerCase();
    if (seen.has(lower)) throw new StackPackError(`仅大小写不同的重复路径：${item.rel}`, 'STACK_PATH');
    seen.add(lower);
    if (item.size > PACK_LIMITS.fileBytes) {
      throw new StackPackError(`单文件超过 1 MiB：${item.rel}`, 'STACK_SIZE');
    }
    total += item.size;
    if (total > PACK_LIMITS.packBytes) {
      throw new StackPackError('整包超过 10 MiB', 'STACK_SIZE');
    }
    if (item.rel !== 'stack.json') contents.set(item.rel, readUtf8(item.abs, item.rel));
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(stackFile, 'utf8'));
  } catch {
    // 不拼接 V8 的解析消息：它可能回显文件片段。
    throw new StackPackError('stack.json 不是合法 JSON', 'STACK_JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new StackPackError('stack.json 必须是 JSON 对象', 'STACK_JSON');
  }
  if (!isValidStackName(manifest.name)) {
    throw new StackPackError(`stack.json 的 name 非法：${manifest.name}`, 'STACK_JSON');
  }
  if (packId && manifest.name !== packId) {
    throw new StackPackError(`stack.json 的 name 与包名不一致：${manifest.name} ≠ ${packId}`, 'STACK_JSON');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new StackPackError('stack.json 的 version 必须是 x.y.z', 'STACK_JSON');
  }
  if (manifest.minDevflow != null && pluginVersion) {
    try {
      if (!satisfies(pluginVersion, String(manifest.minDevflow))) {
        throw new StackPackError(`minDevflow 要求 devflow ${manifest.minDevflow}，当前为 ${pluginVersion}`, 'STACK_COMPAT');
      }
    } catch (err) {
      if (err instanceof StackPackError) throw err;
      throw new StackPackError(`minDevflow 无法解析：${manifest.minDevflow}`, 'STACK_COMPAT');
    }
  }
  if (!Array.isArray(manifest.detects)) {
    throw new StackPackError('stack.json 的 detects 必须是数组', 'STACK_JSON');
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new StackPackError('stack.json 的 files 必须是对象', 'STACK_JSON');
  }

  // 清单与磁盘文件必须双向一一对应：漏登记和登记了不存在的文件都拒绝。
  const declared = new Set(Object.keys(manifest.files).map((rel) => rel.toLowerCase()));
  const actual = new Set([...contents.keys()].map((rel) => rel.toLowerCase()));
  for (const rel of actual) {
    if (!declared.has(rel)) throw new StackPackError(`stack.json 的 files 未覆盖：${rel}`, 'STACK_HASH');
  }
  for (const rel of declared) {
    if (!actual.has(rel)) throw new StackPackError(`stack.json 登记了不存在的文件：${rel}`, 'STACK_HASH');
  }

  const files = [];
  const warnings = [];
  for (const [rel, text] of contents) {
    const hash = contentHash(text);
    if (manifest.files[rel] !== hash) {
      throw new StackPackError(`文件哈希不一致：${rel}`, 'STACK_HASH');
    }
    files.push({ rel, text, hash });
    for (const issue of templateIssues(text, { loaderFiles, pluginVersion })) {
      if (issue.severity === 'error') {
        throw new StackPackError(`${rel}：${issue.message}`, 'STACK_COMPAT');
      }
      warnings.push(`${rel}：${issue.message}`);
    }
    for (const message of scanDangerous(text)) warnings.push(`${rel}：${message}`);
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const pack = { id: manifest.name, packId: packId || manifest.name, manifest, files, warnings };
  if (indexEntry) validatePackAgainstIndex(pack, indexEntry, pack.packId);
  return pack;
}

/** 包目录与 index.json 的包名、detects 必须一致，防止索引把包指到错误的位置。 */
export function validatePackAgainstIndex(pack, indexEntry, packId) {
  if (pack.manifest.name !== packId) {
    throw new StackPackError(`index 包名 ${packId} 与 stack.json 的 ${pack.manifest.name} 不一致`, 'STACK_INDEX');
  }
  const a = [...pack.manifest.detects].sort();
  const b = [...(indexEntry.detects || [])].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new StackPackError(`index 与 stack.json 的 detects 不一致：${packId}`, 'STACK_INDEX');
  }
}
