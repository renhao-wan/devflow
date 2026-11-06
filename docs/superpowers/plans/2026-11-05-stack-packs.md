# 技术栈包（stack packs）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 devflow 能从独立仓库按需安装单个技术栈包到 `.claude/hub/stacks/<stack>/`，并支持离线缓存、按 commit 复现、更新、恢复与删除。

**Architecture:** 分三层：`lib/stack-pack.mjs` 负责清单、路径、哈希与兼容性校验；`lib/stack-fetch.mjs` 负责 bare 缓存与不可变快照；`lib/stack-install.mjs` 负责状态机、三方合并与安装事务。`scripts/hub-stack.mjs` 提供 CLI，`sync`、`upstream`、`ship`、`doctor`、`init` 通过账本接入。

**Tech Stack:** Node.js >= 20.11、ESM、`node:test`、Git CLI（bare repo、`ls-tree`、`cat-file`）、现有 `common.mjs`/`upstream.mjs` 工具。

**Spec:** `docs/stack-packs-design.md`

## Global Constraints

- Node.js `>= 20.11`；只用 Node 标准库与 Git CLI，不新增依赖。
- 所有测试离线运行：使用临时 Git fixture 或 `--from` 目录，不访问网络。
- 测试必须把 `DEVFLOW_CACHE_DIR` 指向临时目录，并设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`。
- 哈希统一使用 `contentHash`（LF 归一化）的纯 hex，不带 `sha256:` 前缀。
- 安装、更新、删除都不改写 `hub.yaml`；来源写入 `.claude/hub/stack-lock.yaml`，本机事实写入 `.claude/.stack-sources.json`（后者入 `.gitignore`）。
- 缓存、快照与安装账本使用 `failClosed` 锁：超时抛错，不降级为无锁执行。安装事务的串行化锁文件是 `.claude/.stack-staging/install.lock`。
- 事务提交后运行 `node scripts/gen-claude-skills.mjs`；不存在 `hub-gen.mjs`，`--no-gen` 跳过。gen 失败只警告，不回滚安装。
- `--force` 只覆盖本机目标目录，不绕过 URL、路径、扩展名、大小、哈希、`minDevflow` 或 loader 校验。
- 账本损坏时 fail closed；不能当成“没有受管栈”继续。
- 不主动修改版本号，不创建发布提交；是否发版由维护者单独决定。
- Git 提交信息使用 `type(scope): subject`，中文描述，不包含 Claude 元信息。

---

## 文件结构

**新建：**

- `scripts/lib/stack-pack.mjs`：URL、索引、包目录、白名单、哈希、兼容性与危险指令扫描。
- `scripts/lib/stack-ledger.mjs`：`.stack-sources.json`、`stack-lock.yaml`、bases/staging/trash 路径，托管目录集合与 owner 转移。
- `scripts/lib/stack-install.mjs`：目标状态机、安装事务、更新合并与恢复采纳。
- `scripts/lib/stack-fetch.mjs`：bare 缓存、ref/commit 解析、对象物化、快照完整性、cache gc 支撑。
- `scripts/hub-stack.mjs`：`devflow stack` 子命令实现。
- `skills/stack/SKILL.md`：显式触发的 stack 技能。
- `tests/stack-pack.test.mjs`、`tests/stack-ledger.test.mjs`、`tests/stack-install.test.mjs`、`tests/stack-fetch.test.mjs`、`tests/stack-cli.test.mjs`、`tests/stack-integration.test.mjs`
- `tests/fixtures/stack-pack/`：静态包仓库样例。

**修改：**

- `scripts/lib/common.mjs`：`withFileLock` 增加 `failClosed`。
- `scripts/lib/cli-commands.mjs`：注册 `stack`。
- `scripts/lib/loaders.mjs`：增加 `devflow-stack.mjs`。
- `scripts/lib/upstream.mjs`：`resolveUnits` 支持跳过受管栈。
- `scripts/hub-sync.mjs`、`scripts/hub-upstream.mjs`、`scripts/hub-ship.mjs`：过滤受管栈，fail closed。
- `scripts/hub-doctor.mjs`：账本、文件、lock、陈旧 owner 记录检查。
- `scripts/hub-init.mjs`：`.gitignore` 片段、Java/Vue 安装提示。
- `scripts/lib/discover.mjs`：Vue 3 识别。
- `bin/devflow`：帮助示例。
- `docs/usage.md`、`README.md`：命令与边界说明。

---

## Phase A：stack-pack + `--from` 本地安装

### Task 1: 仓库 URL 与 `index.json` 校验

**Files:**
- Create: `scripts/lib/stack-pack.mjs`
- Test: `tests/stack-pack.test.mjs`

**Interfaces:**
- Consumes: `contentHash`、`satisfies`、`isPathInside`、`isValidStackName`。
- Produces:
  - `class StackPackError extends Error { code: string }`
  - `normalizeRepoUrl(input: string, opts?: {allowFile?: boolean}): string`
  - `repoCacheId(url: string, opts?: {allowFile?: boolean}): string`
  - `readIndex(rootDir: string): { schemaVersion: 1, packs: Record<string, object> }`
  - `validateIndex(data): { schemaVersion: 1, packs: Record<string, object> }`
  - `resolveIndexPack(index, packId: string, rootDir: string): { packId, entry, packDir }`
  - `PACK_LIMITS`

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-pack.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StackPackError, normalizeRepoUrl, repoCacheId, readIndex, resolveIndexPack,
} from '../scripts/lib/stack-pack.mjs';

test('仓库 URL 只接受白名单协议并拒绝凭据', () => {
  assert.equal(
    normalizeRepoUrl('https://github.com/org/devflow-stacks.git'),
    'https://github.com/org/devflow-stacks.git',
  );
  assert.equal(normalizeRepoUrl('git@github.com:org/devflow-stacks.git'), 'git@github.com:org/devflow-stacks.git');
  for (const bad of [
    'http://github.com/org/repo',
    'file:///tmp/repo',
    'https://user:pass@github.com/org/repo',
    'ssh://user:pass@github.com/org/repo',
    '-uhttps://github.com/org/repo',
    'ext::sh -c echo',
    'transport::http',
  ]) {
    assert.throws(() => normalizeRepoUrl(bad), StackPackError, bad);
  }
});

test('repoCacheId 稳定且不含凭据', () => {
  const a = repoCacheId('https://github.com/org/devflow-stacks.git');
  const b = repoCacheId('https://github.com/org/devflow-stacks.git');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('index.json 校验 pack 路径必须留在仓库内', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-index-'));
  try {
    writeFileSync(join(base, 'index.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          title: 'Spring',
          path: 'stacks/java-spring',
          detects: ['java-maven'],
        },
        escape: { path: '../outside', detects: [] },
      },
    }));
    const index = readIndex(base);
    assert.equal(index.packs['java-spring'].path, 'stacks/java-spring');
    assert.throws(() => resolveIndexPack(index, 'escape', base), /路径越界/);
    assert.throws(() => resolveIndexPack(index, 'missing', base), /不存在/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('index.json 不接受未知 schemaVersion 或缺字段', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-index-bad-'));
  try {
    writeFileSync(join(base, 'index.json'), JSON.stringify({ schemaVersion: 2, packs: {} }));
    assert.throws(() => readIndex(base), /schemaVersion/);
    writeFileSync(join(base, 'index.json'), JSON.stringify({ schemaVersion: 1, packs: { x: { detects: [] } } }));
    assert.throws(() => readIndex(base), /path/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-pack.test.mjs`
Expected: FAIL，`Cannot find module .../stack-pack.mjs`。

- [ ] **Step 3: 实现 URL 与索引校验**

```js
// scripts/lib/stack-pack.mjs
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
  if (!entry) throw new StackPackError(`index.json 中没有包：${packId}`, 'STACK_INDEX');
  const packDir = resolve(rootDir, entry.path);
  if (!isPathInside(rootDir, packDir)) {
    throw new StackPackError(`包路径越界：${packId} → ${entry.path}`, 'STACK_INDEX');
  }
  if (!existsSync(packDir)) {
    throw new StackPackError(`包目录不存在：${posix(packDir)}`, 'STACK_INDEX');
  }
  return { packId, entry, packDir };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-pack.test.mjs`
Expected: PASS，4 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-pack.mjs tests/stack-pack.test.mjs
git commit -m "feat(stack): 校验仓库地址与包索引"
```

---

### Task 2: 包目录、文件白名单与哈希校验

**Files:**
- Modify: `scripts/lib/stack-pack.mjs`
- Test: `tests/stack-pack.test.mjs`

**Interfaces:**
- Consumes: `contentHash`、`templateIssues`、`satisfies`、`isValidStackName`。
- Produces:
  - `readPackFromDir(dir, { packId?, indexEntry?, loaderFiles?, pluginVersion? }): { id, packId, manifest, files: Array<{rel,text,hash}>, warnings: string[] }`
  - `validatePackAgainstIndex(pack, indexEntry, packId): void`
  - `scanDangerous(text: string): string[]`

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-pack.test.mjs 追加
import { readPackFromDir, validatePackAgainstIndex, scanDangerous } from '../scripts/lib/stack-pack.mjs';
import { contentHash } from '../scripts/lib/common.mjs';

function makePack(dir, { files = {}, manifest = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const all = {
    '_shared.md': '# shared\n',
    'plan.md': '# plan\n',
    ...files,
  };
  const hashes = {};
  for (const [rel, text] of Object.entries(all)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
    hashes[rel] = contentHash(text);
  }
  writeFileSync(join(dir, 'stack.json'), JSON.stringify({
    name: 'java-spring',
    title: 'Spring',
    version: '1.2.0',
    minDevflow: '>=1.7.0',
    detects: ['java-maven'],
    files: hashes,
    ...manifest,
  }, null, 2));
}

test('读取合法包并返回文件哈希', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-pack-'));
  try {
    const dir = join(base, 'pack');
    makePack(dir, { files: { 'references/style.md': '# style\n' } });
    const pack = readPackFromDir(dir, { packId: 'java-spring', loaderFiles: new Set(), pluginVersion: '1.7.0' });
    assert.equal(pack.manifest.name, 'java-spring');
    assert.deepEqual(pack.files.map((f) => f.rel).sort(), ['_shared.md', 'plan.md', 'references/style.md']);
    assert.equal(pack.warnings.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝未登记、缺失、越界与非法扩展名文件', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-pack-bad-'));
  try {
    const dir = join(base, 'pack');
    makePack(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'stack.json'), 'utf8'));
    manifest.files = { '_shared.md': manifest.files['_shared.md'] };
    writeFileSync(join(dir, 'stack.json'), JSON.stringify(manifest));
    assert.throws(() => readPackFromDir(dir), /files 未覆盖/);

    makePack(dir);
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n');
    assert.throws(() => readPackFromDir(dir), /不允许的文件/);

    makePack(dir);
    const bad = JSON.parse(readFileSync(join(dir, 'stack.json'), 'utf8'));
    bad.files['_shared.md'] = 'deadbeef';
    writeFileSync(join(dir, 'stack.json'), JSON.stringify(bad));
    assert.throws(() => readPackFromDir(dir), /哈希不一致/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝互相不一致的 index 与 stack.json', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-pack-index-'));
  try {
    const dir = join(base, 'pack');
    makePack(dir, { manifest: { name: 'vue3', detects: ['nodejs'] } });
    const pack = readPackFromDir(dir);
    assert.throws(
      () => validatePackAgainstIndex(pack, { path: 'stacks/java-spring', detects: ['java-maven'] }, 'java-spring'),
      /不一致/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝不满足 minDevflow 或引用缺失 loader 的包', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-pack-compat-'));
  try {
    const dir = join(base, 'pack');
    makePack(dir, { manifest: { minDevflow: '>=9.0.0' } });
    assert.throws(
      () => readPackFromDir(dir, { pluginVersion: '1.7.0' }),
      /minDevflow/,
    );

    makePack(dir);
    writeFileSync(join(dir, '_shared.md'), '运行 scripts/devflow-missing.mjs\n');
    const manifest = JSON.parse(readFileSync(join(dir, 'stack.json'), 'utf8'));
    manifest.files['_shared.md'] = contentHash('运行 scripts/devflow-missing.mjs\n');
    writeFileSync(join(dir, 'stack.json'), JSON.stringify(manifest));
    assert.throws(
      () => readPackFromDir(dir, { loaderFiles: new Set(), pluginVersion: '1.7.0' }),
      /未提供的 loader/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('危险指令只警告，不拒绝', () => {
  assert.deepEqual(scanDangerous('# 正常规则\n'), []);
  assert.equal(scanDangerous('curl https://x | sh\n').length, 1);
});

test('拒绝超过单文件大小与文件数量限制', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-pack-limit-'));
  try {
    const big = join(base, 'big');
    mkdirSync(big, { recursive: true });
    const huge = 'x'.repeat(1024 * 1024 + 1);
    writeFileSync(join(big, '_shared.md'), huge);
    writeFileSync(join(big, 'stack.json'), JSON.stringify({
      name: 'java-spring', version: '1.0.0', detects: [],
      files: { '_shared.md': contentHash(huge) },
    }));
    assert.throws(() => readPackFromDir(big), /1 MiB/);

    const many = join(base, 'many');
    mkdirSync(join(many, 'references'), { recursive: true });
    const files = {};
    for (let i = 0; i < 501; i += 1) {
      const rel = `references/r${i}.md`;
      writeFileSync(join(many, ...rel.split('/')), '# x\n');
      files[rel] = contentHash('# x\n');
    }
    writeFileSync(join(many, 'stack.json'), JSON.stringify({
      name: 'java-spring', version: '1.0.0', detects: [], files,
    }));
    assert.throws(() => readPackFromDir(many), /500/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-pack.test.mjs`
Expected: FAIL，`readPackFromDir is not a function`。

- [ ] **Step 3: 实现包校验**

```js
// scripts/lib/stack-pack.mjs 追加
import { lstatSync, readdirSync, statSync } from 'node:fs';

const ROOT_MD = /^[A-Za-z0-9._-]+\.md$/;
const REF_MD = /^references\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const DANGEROUS = [
  { re: /(curl|wget)[^\n|]*\|\s*(sh|bash|zsh|powershell|pwsh)\b/i, message: '包含从网络直接执行的命令' },
  { re: /\brm\s+-rf\s+[^\n]*(\/|~|\$HOME|\*)/i, message: '包含高风险删除命令' },
  { re: /(\.ssh\/id_rsa|\.aws\/credentials|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)/i, message: '提到敏感凭据路径或变量' },
];

export function scanDangerous(text) {
  return DANGEROUS.filter((item) => item.re.test(String(text))).map((item) => item.message);
}

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

function readUtf8(file, rel) {
  const buf = readFileSync(file);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throw new StackPackError(`不是 UTF-8 文本：${rel}`, 'STACK_ENCODING');
  }
  return text;
}

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
  } catch (err) {
    throw new StackPackError(`stack.json 不是合法 JSON：${err.message}`, 'STACK_JSON');
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
        throw new StackPackError(`包要求 devflow ${manifest.minDevflow}，当前为 ${pluginVersion}`, 'STACK_COMPAT');
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-pack.test.mjs`
Expected: PASS，10 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-pack.mjs tests/stack-pack.test.mjs
git commit -m "feat(stack): 校验包目录、白名单与哈希"
```

---

### Task 3: 严格锁、账本与 lock 读写

**Files:**
- Modify: `scripts/lib/common.mjs:542-575`
- Create: `scripts/lib/stack-ledger.mjs`
- Test: `tests/stack-ledger.test.mjs`

**Interfaces:**
- Consumes: `withFileLock`、`parseYaml`、`writeAtomic`、`StackPackError`。
- Produces:
  - `withFileLock(file, fn, { failClosed?: boolean })`
  - `stackPaths(root): { sources, lock, basesRoot, stagingRoot, trashRoot, stackDir(name), basesDir(name) }`
  - `readSources(root)`（缺失返回空账本，损坏抛错）
  - `writeSources(root, sources)`
  - `readLock(root)`、`writeLock(root, lock)`、`renderLockYaml(lock)`
  - `managedStackPrefixes(sources): string[]`、`managedStackNames(sources): Set<string>`
  - `dropHubOwnership(root, installedAs)`

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-ledger.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../scripts/lib/common.mjs';
import {
  stackPaths, readSources, writeSources, readLock, writeLock, renderLockYaml,
  managedStackNames, dropHubOwnership,
} from '../scripts/lib/stack-ledger.mjs';

test('账本缺失返回空，损坏时 fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ledger-'));
  try {
    assert.deepEqual(readSources(root), { schemaVersion: 1, packs: {} });
    const p = stackPaths(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(p.sources, '{ broken');
    assert.throws(() => readSources(root), /损坏/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('账本往返并推导受管栈', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ledger-write-'));
  try {
    writeSources(root, {
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', repo: 'https://example.com/r.git', packId: 'java-spring',
          path: 'stacks/java-spring', ref: 'main', commit: 'a'.repeat(40), version: '1.2.0', source: 'git',
        },
      },
    });
    const data = readSources(root);
    assert.equal(data.packs['java-spring'].version, '1.2.0');
    assert.deepEqual([...managedStackNames(data)], ['java-spring']);
    assert.equal(
      stackPaths(root).stackDir('java-spring'),
      join(root, '.claude', 'hub', 'stacks', 'java-spring'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lock 往返保留未知顶层标量字段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-lock-'));
  try {
    const lock = {
      version: 1,
      futureField: 'keep-me',
      packs: {
        'java-spring': {
          installedAs: 'java-spring', repo: 'https://example.com/r.git', packId: 'java-spring',
          path: 'stacks/java-spring', ref: 'main', commit: 'b'.repeat(40), version: '1.2.0',
        },
      },
    };
    writeLock(root, lock);
    const text = readFileSync(stackPaths(root).lock, 'utf8');
    assert.match(text, /^version: 1/m);
    const parsed = parseYaml(text);
    assert.equal(parsed.futureField, 'keep-me');
    assert.equal(readLock(root).packs['java-spring'].commit, 'b'.repeat(40));
    assert.match(renderLockYaml(lock), /packs:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner 转移删除旧 hub-sources 记录与 bases', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-owner-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: {
        '.claude/hub/stacks/java-spring/_shared.md': { base: 'x', local: 'x' },
        '.claude/hub/stages/req/SKILL.md': { base: 'y', local: 'y' },
      },
    }));
    const baseDir = join(root, '.claude', '.hub-bases', 'stacks', 'java-spring');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, '_shared.md'), 'old');

    dropHubOwnership(root, 'java-spring');

    const data = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(data.files['.claude/hub/stacks/java-spring/_shared.md'], undefined);
    assert.ok(data.files['.claude/hub/stages/req/SKILL.md']);
    assert.equal(existsSync(baseDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-ledger.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 给 `withFileLock` 增加 failClosed**

```js
// scripts/lib/common.mjs 的 withFileLock
export function withFileLock(file, fn, { timeoutMs = 2000, staleMs = 15000, failClosed = false } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (true) {
    try {
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      // 非 EEXIST（权限、磁盘错误等）同样不能静默降级为无锁执行。
      if (err.code !== 'EEXIST') {
        if (failClosed) throw err;
        break;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch { /* 锁刚被释放，重试 */ }
      if (Date.now() >= deadline) {
        if (failClosed) throw new Error(`获取锁超时：${lock}`);
        break;
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        const owner = readText(lock).split('\n')[0].trim();
        if (owner === String(process.pid)) rmSync(lock, { force: true });
      } catch { /* 清理失败不影响结果 */ }
    }
  }
}
```

- [ ] **Step 4: 实现账本模块**

```js
// scripts/lib/stack-ledger.mjs
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ensureDir, parseYaml, posix, readText, withFileLock, writeAtomic,
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
  } catch (err) {
    throw new StackPackError(`安装账本损坏：${posix(sources)}（${err.message}）；运行 devflow stack status 或 doctor`, 'STACK_LEDGER');
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
  const { sources: file } = stackPaths(root);
  ensureDir(join(root, '.claude'));
  withFileLock(file, () => {
    writeAtomic(file, `${JSON.stringify(sources, null, 2)}\n`);
  }, { failClosed: true });
}

export function readLock(root) {
  const { lock } = stackPaths(root);
  if (!existsSync(lock)) return { version: 1, packs: {} };
  let data;
  try {
    data = parseYaml(readText(lock));
  } catch (err) {
    throw new StackPackError(`stack-lock.yaml 解析失败：${err.message}`, 'STACK_LOCK');
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
  const { lock: file } = stackPaths(root);
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/stack-ledger.test.mjs`
Expected: PASS，4 个测试通过。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/common.mjs scripts/lib/stack-ledger.mjs tests/stack-ledger.test.mjs
git commit -m "feat(stack): 增加严格锁与本地账本"
```

---

### Task 4: 目标状态机

**Files:**
- Create: `scripts/lib/stack-install.mjs`
- Test: `tests/stack-install.test.mjs`

**Interfaces:**
- Consumes: `stackPaths`、`readSources`、`readLock`、`contentHash`。
- Produces:
  - `targetSnapshot(root, installedAs, pack): { exists, matches, changed, missing, extra }`
  - `classifyInstall({ installedAs?, targetExists, targetMatches?, record?, lockEntry?, force?, source? }): 'fresh'|'restore'|'update'|'adopt'|'takeover'|'conflict'|'other-owner'`

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-install.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../scripts/lib/common.mjs';
import { classifyInstall, targetSnapshot } from '../scripts/lib/stack-install.mjs';

function packOf(files) {
  return {
    manifest: { name: 'java-spring', version: '1.2.0' },
    files: Object.entries(files).map(([rel, text]) => ({ rel, text, hash: contentHash(text) })),
  };
}

test('目标状态机覆盖设计文档的 8 种组合', () => {
  const installedAs = 'java-spring';
  const record = { installedAs };
  assert.equal(classifyInstall({ installedAs, targetExists: false, record: null, lockEntry: null }), 'fresh');
  assert.equal(classifyInstall({ installedAs, targetExists: false, record, lockEntry: {} }), 'restore');
  assert.equal(classifyInstall({ installedAs, targetExists: false, record, lockEntry: null }), 'restore');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: true, record, lockEntry: {} }), 'update');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: true, record, lockEntry: null }), 'update');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: true, record: null, lockEntry: {} }), 'adopt');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: false, record: null, lockEntry: {}, force: false }), 'conflict');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: false, record: null, lockEntry: {}, force: true }), 'takeover');
  assert.equal(classifyInstall({ installedAs, targetExists: true, record: { installedAs: 'other' }, lockEntry: null }), 'other-owner');
  assert.equal(classifyInstall({ installedAs, targetExists: true, record: null, lockEntry: null, force: true }), 'takeover');
});

test('同一 installedAs 但来源不同时拒绝', () => {
  const installedAs = 'java-spring';
  const gitRecord = { installedAs, source: 'git', repo: 'https://example.com/a.git', packId: 'java-spring' };
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: gitRecord, lockEntry: {},
    source: { type: 'git', repo: 'https://example.com/b.git', packId: 'java-spring' },
  }), 'other-owner');
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: gitRecord, lockEntry: {},
    source: { type: 'git', repo: 'https://example.com/a.git', packId: 'other' },
  }), 'other-owner');
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: gitRecord, lockEntry: {},
    source: { type: 'git', repo: 'https://example.com/a.git', packId: 'java-spring' },
  }), 'update');
  const localRecord = { installedAs, source: 'local', localPath: '/a', packId: 'java-spring' };
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: localRecord, lockEntry: {},
    source: { type: 'local', localPath: '/b', packId: 'java-spring' },
  }), 'other-owner');
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: localRecord, lockEntry: {},
    source: { type: 'local', localPath: '/a', packId: 'java-spring' },
  }), 'update');
});

test('targetSnapshot 报告匹配、改动与缺失文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-target-'));
  try {
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# shared\n');
    writeFileSync(join(dir, 'extra.md'), '# extra\n');
    const pack = packOf({ '_shared.md': '# shared\n', 'plan.md': '# plan\n' });
    const snap = targetSnapshot(root, 'java-spring', pack);
    assert.equal(snap.exists, true);
    assert.equal(snap.matches, false);
    assert.deepEqual(snap.missing, ['plan.md']);
    assert.deepEqual(snap.changed, []);
    assert.deepEqual(snap.extra, ['extra.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-install.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现状态机**

```js
// scripts/lib/stack-install.mjs
import { existsSync, readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './common.mjs';
import { stackPaths } from './stack-ledger.mjs';

function listTree(dir, rel = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (lstatSync(abs).isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...listTree(abs, childRel));
    else if (entry.isFile()) out.push({ abs, rel: childRel });
  }
  return out;
}

export function targetSnapshot(root, installedAs, pack) {
  const dir = stackPaths(root).stackDir(installedAs);
  if (!existsSync(dir)) {
    return { exists: false, matches: false, changed: [], missing: [], extra: [] };
  }
  const current = new Map(listTree(dir).map((file) => [file.rel, file.abs]));
  // Windows 文件系统大小写不敏感：按实际列出的名称匹配，避免把 Plan.md 误判成缺失。
  const byLower = new Map([...current.keys()].map((rel) => [rel.toLowerCase(), rel]));
  const expected = new Map(pack.files.map((file) => [file.rel, file]));
  const expectedLower = new Set([...expected.keys()].map((rel) => rel.toLowerCase()));
  const changed = [];
  const missing = [];
  for (const [rel, file] of expected) {
    const actualRel = current.has(rel) ? rel : byLower.get(rel.toLowerCase());
    if (!actualRel) {
      missing.push(rel);
      continue;
    }
    if (contentHash(readFileSync(current.get(actualRel), 'utf8')) !== file.hash) changed.push(rel);
  }
  const extra = [...current.keys()].filter((rel) => !expectedLower.has(rel.toLowerCase())).sort();
  return {
    exists: true,
    matches: changed.length === 0 && missing.length === 0,
    changed,
    missing,
    extra,
  };
}

export function classifyInstall({
  installedAs = null, targetExists, targetMatches = false,
  record = null, lockEntry = null, force = false, source = null,
}) {
  if (record && installedAs && record.installedAs !== installedAs) return 'other-owner';
  // 同一 installedAs 可能来自不同仓库或不同包；设计第 7 节要求先 remove。
  if (record && source && record.source) {
    const samePack = record.packId === (source.packId || record.packId);
    const sameSource = record.source === 'local'
      ? (source.type === 'local' && record.localPath === source.localPath)
      : (source.type === 'git' && record.repo === source.repo);
    if (!samePack || !sameSource) return 'other-owner';
  }
  if (targetExists) {
    if (record) return 'update';
    if (lockEntry) return targetMatches ? 'adopt' : (force ? 'takeover' : 'conflict');
    return force ? 'takeover' : 'conflict';
  }
  return record ? 'restore' : 'fresh';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-install.test.mjs`
Expected: PASS，3 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-install.mjs tests/stack-install.test.mjs
git commit -m "feat(stack): 增加安装目标状态机"
```

---

### Task 5: 安装事务与回滚（含第 4 步中途失败）

**Files:**
- Modify: `scripts/lib/stack-install.mjs`
- Test: `tests/stack-install.test.mjs`

**Interfaces:**
- Consumes: `stackPaths`、`readSources`、`readLock`、`writeLock`、`dropHubOwnership`、`writeAtomic`。
- Produces:
  - `ledgerRecord({ installedAs, pack, source, localHashes? }): object`
  - `hashTree(dir, rels): Map<string, string|null>`
  - `writePackTree(dir, pack): void`
  - `lockEntryFor({ installedAs, source, pack }): object`
  - `commitStagedTree({ root, installedAs, source, pack, record, stagedTarget, stagedBases, force?, ops?, onWarn? }): void`
  - `applyInstall({ root, installedAs, pack, source, sources, force?, noGen?, generate?, ops?, onWarn? }): { action }`

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-install.test.mjs 追加
import { readFileSync, existsSync } from 'node:fs';
import { readSources } from '../scripts/lib/stack-ledger.mjs';
import { applyInstall } from '../scripts/lib/stack-install.mjs';

test('全新安装写入目录、bases 与账本', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-'));
  try {
    const pack = packOf({ '_shared.md': '# shared\n', 'plan.md': '# plan\n' });
    const result = applyInstall({
      root,
      installedAs: 'java-spring',
      pack,
      source: { type: 'local', localPath: '/tmp/stacks', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    });
    assert.equal(result.action, 'fresh');
    assert.equal(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), '# plan\n');
    assert.equal(readFileSync(join(root, '.claude', '.stack-bases', 'java-spring', 'plan.md'), 'utf8'), '# plan\n');
    const ledger = readSources(root);
    assert.equal(ledger.packs['java-spring'].source, 'local');
    assert.equal(
      ledger.packs['java-spring'].files['.claude/hub/stacks/java-spring/plan.md'].base,
      contentHash('# plan\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('第 4 步移动 bases 失败时恢复已移走的旧目录，账本保持不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-rollback-'));
  try {
    const target = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    const bases = join(root, '.claude', '.stack-bases', 'java-spring');
    mkdirSync(target, { recursive: true });
    mkdirSync(bases, { recursive: true });
    writeFileSync(join(target, '_shared.md'), '# old\n');
    writeFileSync(join(bases, '_shared.md'), '# old\n');
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/new', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0',
          files: { '.claude/hub/stacks/java-spring/_shared.md': { base: contentHash('# old\n'), local: contentHash('# old\n') } },
        },
      },
    }, null, 2));
    const before = readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8');

    let renamedBases = false;
    const ops = {
      renameSync(from, to) {
        if (from === bases) {
          renamedBases = true;
          throw new Error('模拟移动 bases 失败');
        }
        return renameSync(from, to);
      },
      rmSync,
    };

    assert.throws(() => applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# new\n' }),
      source: { type: 'local', localPath: '/new', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: readSources(root),
      noGen: true,
      ops,
    }), /模拟移动 bases 失败/);
    assert.equal(renamedBases, true);
    assert.equal(readFileSync(join(target, '_shared.md'), 'utf8'), '# old\n');
    assert.equal(readFileSync(join(bases, '_shared.md'), 'utf8'), '# old\n');
    assert.equal(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无账本且已有目录时默认拒绝，--force 才接管', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-force-'));
  try {
    mkdirSync(join(root, '.claude', 'hub', 'stacks', 'java-spring'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), '# local\n');
    const args = {
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# pack\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    };
    assert.throws(() => applyInstall(args), /--force/);
    const result = applyInstall({ ...args, force: true });
    assert.equal(result.action, 'takeover');
    assert.equal(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), '# pack\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目标目录被 junction 引到项目外时拒绝安装', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'devflow-install-outside-'));
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    symlinkSync(outside, join(root, '.claude', 'hub', 'stacks'), 'junction');
    assert.throws(() => applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    }), /越界/);
    assert.equal(existsSync(join(outside, 'java-spring')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
```

测试文件顶部的 `node:fs` 导入需要加入 `renameSync` 与 `symlinkSync`；`readFileSync`、`existsSync` 与 `readSources` 由本步骤的追加导入提供。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-install.test.mjs`
Expected: FAIL，`applyInstall is not a function`。

- [ ] **Step 3: 实现事务**

```js
// scripts/lib/stack-install.mjs 追加
import {
  cpSync, mkdirSync, renameSync, rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  ensureDir, isPathInside, isRealPathInside, loadHub, posix, withFileLock, writeAtomic,
} from './common.mjs';
import {
  dropHubOwnership, readLock, readSources, stackPaths, writeLock,
} from './stack-ledger.mjs';

const DEFAULT_OPS = { renameSync, rmSync };

function tag() {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

export function writePackTree(dir, pack) {
  for (const file of pack.files) {
    const abs = join(dir, ...file.rel.split('/'));
    ensureDir(dirname(abs));
    writeAtomic(abs, file.text);
  }
}

export function ledgerRecord({ installedAs, pack, source, localHashes = null }) {
  const files = {};
  for (const file of pack.files) {
    const local = localHashes ? (localHashes.get(file.rel) ?? null) : file.hash;
    files[`.claude/hub/stacks/${installedAs}/${file.rel}`] = { base: file.hash, local };
  }
  const base = {
    installedAs,
    packId: source.packId || pack.manifest.name,
    path: source.path,
    version: pack.manifest.version,
    installedAt: new Date().toISOString(),
    files,
  };
  if (source.type === 'git') {
    return { ...base, source: 'git', repo: source.repo, ref: source.ref, commit: source.commit };
  }
  return { ...base, source: 'local', localPath: source.localPath, ref: null, commit: null };
}

/** 读取 staging 中实际写入的内容哈希；本地已删除的文件记为 null。 */
export function hashTree(dir, rels) {
  const out = new Map();
  for (const rel of rels) {
    const abs = join(dir, ...rel.split('/'));
    out.set(rel, existsSync(abs) ? contentHash(readFileSync(abs, 'utf8')) : null);
  }
  return out;
}

/** 安装事务共用入口；严格锁保证账本与目录替换不会被并发写坏。 */
export function commitStagedTree(args) {
  const lockFile = join(stackPaths(args.root).stagingRoot, 'install.lock');
  return withFileLock(lockFile, () => commitStagedTreeLocked(args), {
    failClosed: true, timeoutMs: 10000,
  });
}

/** lock 与账本共用同一来源身份，避免两处字段漂移。 */
export function lockEntryFor({ installedAs, source, pack }) {
  return {
    installedAs,
    repo: source.repo,
    packId: source.packId || pack.manifest.name,
    path: source.path,
    ref: source.ref,
    commit: source.commit,
    version: pack.manifest.version,
  };
}

function commitStagedTreeLocked({
  root, installedAs, source, pack, record, stagedTarget, stagedBases,
  force = false, ops = DEFAULT_OPS, onWarn = () => {},
}) {
  const paths = stackPaths(root);
  const target = paths.stackDir(installedAs);
  const bases = paths.basesDir(installedAs);
  // 锁外判定只用于提前失败；锁内必须按最新账本与目标目录重新裁决，
  // 否则两个并发安装都可能通过 fresh 预检，后到者覆盖先到者。
  const latest = readSources(root);
  const currentLock = readLock(root);
  const current = targetSnapshot(root, installedAs, pack);
  const action = classifyInstall({
    installedAs,
    targetExists: current.exists,
    targetMatches: current.matches,
    record: latest.packs[installedAs] || null,
    lockEntry: currentLock.packs[installedAs] || null,
    force,
    source,
  });
  if (action === 'conflict') {
    throw new Error(`目标目录已存在且内容不同：.claude/hub/stacks/${installedAs}；确认覆盖请加 --force`);
  }
  if (action === 'other-owner') {
    throw new Error(`目标目录已由其他安装占用：.claude/hub/stacks/${installedAs}；先运行 devflow stack remove`);
  }

  const trash = join(paths.trashRoot, tag());
  const tx = { movedTarget: false, movedBases: false, placedTarget: false, placedBases: false };
  try {
    mkdirSync(trash, { recursive: true });
    if (existsSync(target)) {
      ops.renameSync(target, join(trash, installedAs));
      tx.movedTarget = true;
    }
    if (existsSync(bases)) {
      ops.renameSync(bases, join(trash, `${installedAs}-bases`));
      tx.movedBases = true;
    }
    ensureDir(dirname(target));
    ops.renameSync(stagedTarget, target);
    tx.placedTarget = true;
    ensureDir(dirname(bases));
    ops.renameSync(stagedBases, bases);
    tx.placedBases = true;
    // 账本 rename 是提交点；此前任何失败都回滚。
    const nextSources = {
      ...latest,
      schemaVersion: 1,
      packs: { ...latest.packs, [installedAs]: record },
    };
    writeAtomic(paths.sources, `${JSON.stringify(nextSources, null, 2)}\n`);
  } catch (err) {
    rollback(tx, { target, bases, trash, installedAs, ops });
    throw err;
  }
  // 第 7 步成功后才清理旧目录与旧 bases 备份。
  rmSync(trash, { recursive: true, force: true });

  try {
    dropHubOwnership(root, installedAs);
  } catch (err) {
    onWarn(`owner 转移失败：${err.message}；运行 devflow doctor 检查`);
  }

  try {
    const lock = readLock(root);
    if (source.type === 'git') lock.packs[installedAs] = lockEntryFor({ installedAs, source, pack });
    else delete lock.packs[installedAs];
    writeLock(root, lock);
  } catch (err) {
    onWarn(`写入 stack-lock.yaml 失败：${err.message}；运行 devflow stack lock 重建`);
  }
}

function rollback(tx, { target, bases, trash, installedAs, ops }) {
  // 先把本次换入的新 bases 移走，否则恢复旧 bases 时会撞上非空目录；
  // 再恢复旧目录与旧 bases，最后删除备份。
  if (tx.placedBases) {
    ensureDir(trash);
    ops.renameSync(bases, join(trash, `${installedAs}-new-bases`));
  }
  if (tx.placedTarget) ops.rmSync(target, { recursive: true, force: true });
  if (tx.movedTarget) {
    ensureDir(dirname(target));
    ops.renameSync(join(trash, installedAs), target);
  }
  if (tx.movedBases) {
    ensureDir(dirname(bases));
    ops.renameSync(join(trash, `${installedAs}-bases`), bases);
  }
  ops.rmSync(trash, { recursive: true, force: true });
}

/** hub.yaml 把同一路径声明给另一个栈名时，安装会制造双 owner。 */
function declaredConflict(root, installedAs) {
  if (!existsSync(join(root, '.claude', 'hub', 'hub.yaml'))) return null;
  const { config } = loadHub(root);
  const target = posix(resolve(root, '.claude', 'hub', 'stacks', installedAs));
  const subs = config.subprojects && typeof config.subprojects === 'object' ? config.subprojects : {};
  for (const sub of Object.values(subs)) {
    if (!sub || typeof sub !== 'object') continue;
    if (!sub.stack || String(sub.stack) === installedAs) continue;
    if (sub.path && posix(resolve(root, String(sub.path))) === target) return String(sub.stack);
  }
  return null;
}

export function applyInstall({
  root, installedAs, pack, source, sources, force = false,
  noGen = false, generate = null, ops = DEFAULT_OPS, onWarn = () => {},
}) {
  const target = stackPaths(root).stackDir(installedAs);
  // --force 只覆盖目录，不能绕过“目标必须在项目内”的约束。
  if (!isPathInside(root, target) || !isRealPathInside(root, target)) {
    throw new Error(`目标目录越界（可能被 junction/符号链接引到项目外）：.claude/hub/stacks/${installedAs}`);
  }
  const conflictsWith = declaredConflict(root, installedAs);
  if (conflictsWith) {
    throw new Error(`.claude/hub/stacks/${installedAs} 已声明给 ${conflictsWith}；先修正 hub.yaml`);
  }
  const lock = readLock(root);
  const record = sources.packs[installedAs] || null;
  const snap = targetSnapshot(root, installedAs, pack);
  const action = classifyInstall({
    installedAs,
    targetExists: snap.exists,
    targetMatches: snap.matches,
    record,
    lockEntry: lock.packs[installedAs] || null,
    force,
    source,
  });
  if (action === 'conflict') {
    throw new Error(`目标目录已存在且内容不同：.claude/hub/stacks/${installedAs}；确认覆盖请加 --force`);
  }
  if (action === 'other-owner') {
    throw new Error(`目标目录已由其他安装占用：.claude/hub/stacks/${installedAs}；先运行 devflow stack remove`);
  }

  const paths = stackPaths(root);
  const stageRoot = join(paths.stagingRoot, tag());
  const stagedTarget = join(stageRoot, 'target');
  const stagedBases = join(stageRoot, 'bases');
  writePackTree(stagedTarget, pack);
  writePackTree(stagedBases, pack);
  const localHashes = hashTree(stagedTarget, pack.files.map((file) => file.rel));
  const nextRecord = ledgerRecord({ installedAs, pack, source, localHashes });
  try {
    commitStagedTree({
      root, installedAs, source, pack, record: nextRecord,
      stagedTarget, stagedBases, force, ops, onWarn,
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  if (!noGen && generate) generate(root);
  return { action };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-install.test.mjs`
Expected: PASS，7 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-install.mjs tests/stack-install.test.mjs
git commit -m "feat(stack): 实现安装事务与回滚"
```

---

### Task 6: `devflow stack add --from` 与 `lint`

**Files:**
- Create: `scripts/hub-stack.mjs`
- Modify: `scripts/lib/cli-commands.mjs:5-20`
- Modify: `scripts/lib/loaders.mjs:5-14`
- Test: `tests/stack-cli.test.mjs`

**Interfaces:**
- Consumes: `readIndex`、`resolveIndexPack`、`readPackFromDir`、`readSources`、`applyInstall`、`LOADERS`、`pluginInfo`、`isValidStackName`、`loadHub`。
- Produces:
  - `hub-stack.mjs main(argv): Promise<unknown>`
  - `COMMANDS.stack`
  - `LOADERS['devflow-stack.mjs']`

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-cli.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contentHash } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function makeProject(base) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
  const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return root;
}

function makeStackRepo(base) {
  const repo = join(base, 'stacks-repo');
  const files = { '_shared.md': '# shared\n', 'plan.md': '# plan\n' };
  const hashes = {};
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, 'stacks', 'java-spring', ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
    hashes[rel] = contentHash(text);
  }
  writeFileSync(join(repo, 'stacks', 'java-spring', 'stack.json'), JSON.stringify({
    name: 'java-spring', title: 'Spring', version: '1.2.0', minDevflow: '>=1.7.0',
    detects: ['java-maven'], files: hashes,
  }, null, 2));
  writeFileSync(join(repo, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    packs: { 'java-spring': { title: 'Spring', path: 'stacks/java-spring', detects: ['java-maven'] } },
  }, null, 2));
  return repo;
}

test('stack add --from 安装并写入 .stack-sources.json', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-cli-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), /plan/);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'].source, 'local');
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stack-lock.yaml')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack lint 校验仓库样例', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-lint-'));
  try {
    const repo = makeStackRepo(base);
    const res = run('hub-stack.mjs', ['lint', repo], base);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init 生成 stack loader，CLI 注册 stack 子命令', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-loader-'));
  try {
    const root = makeProject(base);
    assert.equal(existsSync(join(root, 'scripts', 'devflow-stack.mjs')), true);
    const help = spawnSync(NODE, [join(PLUGIN_ROOT, 'bin', 'devflow'), 'help'], { encoding: 'utf8' });
    assert.match(help.stdout, /stack/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-cli.test.mjs`
Expected: FAIL，`hub-stack.mjs` 不存在。

- [ ] **Step 3: 实现 CLI 与注册**

```js
// scripts/hub-stack.mjs
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, isMain, loadHub, log, pluginInfo, projectRoot, warnUnknownArgs,
} from './lib/common.mjs';
import { LOADERS } from './lib/loaders.mjs';
import { isValidStackName } from './lib/stacks.mjs';
import { readIndex, readPackFromDir, resolveIndexPack } from './lib/stack-pack.mjs';
import { readSources } from './lib/stack-ledger.mjs';
import { applyInstall } from './lib/stack-install.mjs';

const VALUE_FLAGS = new Set(['--root', '--repo', '--ref', '--as', '--from', '--keep-days']);

function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function pluginRootFromHere() {
  return resolve(import.meta.dirname, '..');
}

function pluginVersionOf() {
  return pluginInfo(pluginRootFromHere()).version;
}

function loaderFiles() {
  return new Set(Object.keys(LOADERS));
}

/** gen 失败不回滚安装：设计文档第 8 节只要求明确警告。 */
function runGen(root) {
  const script = join(pluginRootFromHere(), 'scripts', 'gen-claude-skills.mjs');
  const res = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  if (res.status !== 0) {
    log('warn', `安装已完成，但 gen 失败：${(res.stderr || res.stdout || '').trim()}`);
    log('warn', '修正 hub.yaml 或栈声明后运行 node scripts/devflow-gen.mjs');
  }
}

/** hub.yaml 顶层 stack 与所有 subprojects.*.stack 的并集。 */
function declaredStacks(root) {
  const { config } = loadHub(root);
  const names = new Set();
  if (config.stack) names.add(String(config.stack));
  const subs = config.subprojects && typeof config.subprojects === 'object' ? config.subprojects : {};
  for (const sub of Object.values(subs)) {
    if (sub && sub.stack) names.add(String(sub.stack));
  }
  return names;
}

function lintPath(path) {
  if (existsSync(join(path, 'index.json'))) {
    const index = readIndex(path);
    for (const packId of Object.keys(index.packs)) {
      const { entry, packDir } = resolveIndexPack(index, packId, path);
      const pack = readPackFromDir(packDir, {
        packId,
        indexEntry: entry,
        loaderFiles: loaderFiles(),
        pluginVersion: pluginVersionOf(),
      });
      log('ok', `${packId}@${pack.manifest.version}（${pack.files.length} 个文件）`);
      for (const warning of pack.warnings) log('warn', `${packId}：${warning}`);
    }
    return;
  }
  const pack = readPackFromDir(path, {
    loaderFiles: loaderFiles(),
    pluginVersion: pluginVersionOf(),
  });
  log('ok', `${pack.id}@${pack.manifest.version}（${pack.files.length} 个文件）`);
  for (const warning of pack.warnings) log('warn', `${pack.id}：${warning}`);
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, [
    '--root', '--repo', '--ref', '--as', '--from', '--offline', '--dry-run', '--force',
    '--no-gen', '--keep', '--purge', '--json', '--all', '--keep-days', '--apply',
  ]);
  const [command, packId] = positionals(argv);
  if (!command) throw new Error('用法：devflow stack <add|list|update|restore|remove|status|lock|lint|cache>');
  const root = projectRoot(argValue(argv, '--root', process.cwd()));

  if (command === 'lint') {
    const path = resolve(packId || '.');
    lintPath(path);
    return { linted: path };
  }

  loadHub(root);

  if (command === 'add') {
    const repo = argValue(argv, '--repo', null);
    const from = argValue(argv, '--from', null);
    if (repo && from) throw new Error('--repo 与 --from 互斥');
    if (!packId) throw new Error('缺少包名：devflow stack add <packId> --from <dir>');
    if (!from) {
      if (repo) {
        throw new Error('远程来源需要 bare 缓存；本阶段请先使用 --from，或完成 lib/stack-fetch.mjs 后重试');
      }
      throw new Error('add 必须提供 --from（本阶段）或 --repo，例如：devflow stack add java-spring --from ../devflow-stacks');
    }
    const fromRoot = resolve(from);
    const index = readIndex(fromRoot);
    const { entry, packDir } = resolveIndexPack(index, packId, fromRoot);
    const pack = readPackFromDir(packDir, {
      packId,
      indexEntry: entry,
      loaderFiles: loaderFiles(),
      pluginVersion: pluginVersionOf(),
    });
    const installedAs = argValue(argv, '--as', packId);
    if (!isValidStackName(installedAs)) {
      throw new Error(`--as 不是合法的栈名：${installedAs}（只允许 [a-z0-9][a-z0-9_-]*）`);
    }
    const source = {
      type: 'local', localPath: fromRoot, packId, path: entry.path,
    };
    if (hasFlag(argv, '--dry-run')) {
      log('info', `将安装 ${packId}@${pack.manifest.version} → .claude/hub/stacks/${installedAs}`);
      return { dryRun: true, packId, installedAs };
    }
    const noGen = hasFlag(argv, '--no-gen');
    const result = applyInstall({
      root,
      installedAs,
      pack,
      source,
      sources: readSources(root),
      force: hasFlag(argv, '--force'),
      noGen,
      generate: noGen ? null : runGen,
      onWarn: (message) => log('warn', message),
    });
    log('ok', `已安装 ${packId}@${pack.manifest.version} → .claude/hub/stacks/${installedAs}（${result.action}）`);
    if (!noGen && !declaredStacks(root).has(installedAs)) {
      log('info', `hub.yaml 尚未声明 ${installedAs}；补充 stack: ${installedAs}（或对应子项目的 stack）后再运行 node scripts/devflow-gen.mjs`);
    }
    return result;
  }

  throw new Error(`暂不支持的子命令：${command}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
```

```js
// scripts/lib/cli-commands.mjs 在 COMMANDS 中追加
  stack: ['hub-stack.mjs', '按需安装、更新、恢复与删除技术栈包（--from 本地目录或 --repo 远程仓库）'],
```

```js
// scripts/lib/loaders.mjs 在 LOADERS 中追加
  'devflow-stack.mjs': 'hub-stack',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-cli.test.mjs`
Expected: PASS，3 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/hub-stack.mjs scripts/lib/cli-commands.mjs scripts/lib/loaders.mjs tests/stack-cli.test.mjs
git commit -m "feat(stack): 支持 --from 本地安装与 lint"
```

---

## Phase B：bare 缓存与快照

### Task 7: bare 缓存、ref 解析与 commit 拉取

**Files:**
- Create: `scripts/lib/stack-fetch.mjs`
- Test: `tests/stack-fetch.test.mjs`

**Interfaces:**
- Consumes: `normalizeRepoUrl`、`repoCacheId`、`withFileLock`、`StackPackError`。
- Produces:
  - `stackCacheRoot(env?): string`
  - `gitRun(args, opts): string`
  - `ensureRepo({ url, cacheRoot, offline?, allowFile?, run? }): { repoGit, cacheId }`
  - `resolveCommit({ repoGit, ref?, offline?, run? }): string`
  - `fetchCommit({ repoGit, commit, ref?, offline?, run? }): void`
  - `refreshRef({ repoGit, ref, run? }): void`

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-fetch.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureRepo, resolveCommit, fetchCommit } from '../scripts/lib/stack-fetch.mjs';

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  return res.stdout.trim();
}

export function makeGitRepo(base, files) {
  const repo = join(base, 'remote');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

test('裸缓存可重复创建并解析 ref', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-'));
  try {
    const remote = makeGitRepo(base, { 'index.json': '{}' });
    const cacheRoot = join(base, 'cache');
    const first = ensureRepo({ url: remote, cacheRoot, allowFile: true });
    const second = ensureRepo({ url: remote, cacheRoot, allowFile: true });
    assert.equal(first.repoGit, second.repoGit);
    assert.equal(existsSync(first.repoGit), true);
    const commit = resolveCommit({ repoGit: first.repoGit, ref: 'main' });
    assert.match(commit, /^[0-9a-f]{40}$/);
    fetchCommit({ repoGit: first.repoGit, commit, ref: 'main' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('离线且缓存不存在时明确失败', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-offline-'));
  try {
    assert.throws(
      () => ensureRepo({ url: 'https://example.com/r.git', cacheRoot: join(base, 'cache'), offline: true }),
      /离线/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-fetch.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现缓存与 ref 解析**

```js
// scripts/lib/stack-fetch.mjs
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withFileLock } from './common.mjs';
import { StackPackError, normalizeRepoUrl, repoCacheId } from './stack-pack.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

export function stackCacheRoot(env = process.env) {
  return resolve(env.DEVFLOW_CACHE_DIR || join(homedir(), '.devflow', 'cache', 'stacks'));
}

export function gitRun(args, { cwd = process.cwd(), input = undefined, timeout = 120000 } = {}) {
  const result = spawnSync('git', args, {
    cwd, input, encoding: 'utf8', timeout, env: GIT_ENV,
  });
  if (result.error) throw new StackPackError(`无法执行 git：${result.error.message}`, 'STACK_GIT');
  if (result.status !== 0) {
    throw new StackPackError(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout || '').trim()}`, 'STACK_GIT');
  }
  return result.stdout;
}

function repoDirs(url, cacheRoot, allowFile) {
  const cacheId = repoCacheId(normalizeRepoUrl(url, { allowFile }));
  const dir = join(cacheRoot, cacheId);
  return { cacheId, dir, repoGit: join(dir, 'repo.git'), locks: join(dir, 'locks') };
}

export function ensureRepo({ url, cacheRoot = stackCacheRoot(), offline = false, allowFile = false, run = gitRun }) {
  const normalized = normalizeRepoUrl(url, { allowFile });
  const dirs = repoDirs(normalized, cacheRoot, allowFile);
  if (existsSync(dirs.repoGit)) return { ...dirs, url: normalized };
  if (offline) {
    throw new StackPackError(`离线模式下缓存不存在：${normalized}`, 'STACK_OFFLINE');
  }
  mkdirSync(dirs.dir, { recursive: true });
  const tmp = join(dirs.dir, `repo.git.tmp-${process.pid}`);
  withFileLock(join(dirs.locks, 'repo.lock'), () => {
    if (existsSync(dirs.repoGit)) return;
    rmSync(tmp, { recursive: true, force: true });
    try {
      run(['clone', '--bare', '--filter=blob:none', '--', normalized, tmp], { cwd: dirs.dir });
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      run(['clone', '--bare', '--', normalized, tmp], { cwd: dirs.dir });
    }
    renameSync(tmp, dirs.repoGit);
  }, { failClosed: true });
  return { ...dirs, url: normalized };
}

function revParse(repoGit, ref, run) {
  try {
    return run(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoGit }).trim();
  } catch {
    return null;
  }
}

/** 强制刷新 ref：分支可能只前进不后退，缓存里的旧值不能代表远程现状。 */
export function refreshRef({ repoGit, ref, run = gitRun }) {
  const value = String(ref);
  if (!value || value.startsWith('-')) throw new StackPackError(`非法 ref：${value}`, 'STACK_REF');
  try {
    run(['fetch', '--filter=blob:none', 'origin', value], { cwd: repoGit });
  } catch {
    run(['fetch', 'origin', value], { cwd: repoGit });
  }
}

export function fetchCommit({ repoGit, commit, ref = null, offline = false, run = gitRun }) {
  // 对象已在本地时不联网；部分克隆只缺 blob，这里只确认 commit 可达。
  if (revParse(repoGit, commit, run)) return;
  if (offline) {
    throw new StackPackError(`离线模式下无法拉取 commit：${commit}`, 'STACK_OFFLINE');
  }
  const candidates = [];
  if (ref) candidates.push(['fetch', '--filter=blob:none', 'origin', String(ref)]);
  candidates.push(['fetch', 'origin', String(commit)]);
  candidates.push(['fetch', 'origin']);
  let last = null;
  for (const args of candidates) {
    try {
      run(args, { cwd: repoGit });
      if (revParse(repoGit, commit, run)) return;
    } catch (err) {
      last = err;
    }
  }
  if (!revParse(repoGit, commit, run)) {
    throw new StackPackError(`无法获取 commit ${commit}${last ? `：${last.message}` : ''}`, 'STACK_GIT');
  }
}

// offline 只允许解析缓存里已有的 ref：rev-parse 读本地对象库，不联网；
// ref 缺失时 fetchCommit 会直接抛 STACK_OFFLINE。
export function resolveCommit({ repoGit, ref = 'main', offline = false, run = gitRun }) {
  const value = String(ref);
  if (!value || value.startsWith('-')) throw new StackPackError(`非法 ref：${value}`, 'STACK_REF');
  let commit = revParse(repoGit, value, run);
  if (!commit) {
    fetchCommit({ repoGit, commit: value, ref: value, offline, run });
    commit = revParse(repoGit, value, run);
  }
  if (!commit) throw new StackPackError(`找不到 ref：${value}`, 'STACK_REF');
  return commit;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-fetch.test.mjs`
Expected: PASS，2 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-fetch.mjs tests/stack-fetch.test.mjs
git commit -m "feat(stack): 增加 bare 缓存与 commit 解析"
```

---

### Task 8: 对象物化、快照完整性与并发

**Files:**
- Modify: `scripts/lib/stack-fetch.mjs`
- Test: `tests/stack-fetch.test.mjs`

**Interfaces:**
- Consumes: `readPackFromDir`、`contentHash`、`withFileLock`。
- Produces:
  - `materializeSnapshot({ repoGit, commit, packId, packPath, cacheRoot, offline?, loaderFiles?, pluginVersion? }): { snapshotDir, metaFile, pack }`
  - `verifySnapshot({ snapshotDir, metaFile, packId, commit }): boolean`
  - `listSnapshots(cacheRoot): Array<{ commit, packId, snapshotDir, metaFile, mtimeMs }>`
  - `readFileAtCommit({ repoGit, commit, file }): string`

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-fetch.test.mjs 追加
import { materializeSnapshot, verifySnapshot } from '../scripts/lib/stack-fetch.mjs';
import { contentHash } from '../scripts/lib/common.mjs';
import { readFileSync, utimesSync } from 'node:fs';

test('按 commit 物化单个包目录并复用快照', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-'));
  try {
    const remote = makeGitRepo(base, {
      'index.json': '{}',
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', minDevflow: '>=1.7.0',
        detects: ['java-maven'],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
      'stacks/vue3/_shared.md': '# vue\n',
    });
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'pack']);
    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    const first = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'), loaderFiles: new Set(), pluginVersion: '1.7.0',
    });
    assert.equal(readFileSync(join(first.snapshotDir, '_shared.md'), 'utf8'), '# shared\n');
    assert.equal(verifySnapshot({ ...first, commit, packId: 'java-spring' }), true);
    assert.equal(existsSync(join(first.snapshotDir, 'stack.json')), true);
    // meta 必须在包目录外：包目录内只能有真正的包文件。
    assert.equal(existsSync(first.metaFile), true);
    assert.equal(existsSync(join(first.snapshotDir, 'java-spring.meta.json')), false);

    const second = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'), loaderFiles: new Set(), pluginVersion: '1.7.0',
    });
    assert.equal(second.snapshotDir, first.snapshotDir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('快照被篡改后重新物化', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-tamper-'));
  try {
    const remote = makeGitRepo(base, {
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', detects: [],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
    });
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'pack']);
    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    const first = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'),
    });
    writeFileSync(join(first.snapshotDir, '_shared.md'), '# hacked\n');
    const second = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'),
    });
    assert.equal(readFileSync(join(second.snapshotDir, '_shared.md'), 'utf8'), '# shared\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝 ls-tree 中的符号链接模式', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-mode-'));
  try {
    const remote = makeGitRepo(base, {
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', detects: [],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
    });
    // 用 git 索引直接写入 120000 模式，避免依赖操作系统的符号链接权限。
    const target = join(base, 'link-target.txt');
    writeFileSync(target, 'target\n');
    const blob = git(remote, ['hash-object', '-w', '--', target]);
    git(remote, ['update-index', '--add', '--cacheinfo', `120000,${blob},stacks/java-spring/link.md`]);
    git(remote, ['commit', '-m', 'link']);

    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    assert.throws(() => materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'),
    }), /符号链接或子模块/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('离线模式下快照缺失直接报错，不落到 git 对象读取', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-offline-'));
  try {
    const remote = makeGitRepo(base, {
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', detects: [],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
    });
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'pack']);
    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    assert.throws(() => materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'), offline: true,
    }), /离线模式下没有可用快照/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-fetch.test.mjs`
Expected: FAIL，`materializeSnapshot is not a function`。

- [ ] **Step 3: 实现物化**

```js
// scripts/lib/stack-fetch.mjs 追加
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir, writeAtomic } from './common.mjs';
import { PACK_LIMITS, StackPackError, readPackFromDir } from './stack-pack.mjs';

function gitRunBuffer(args, { cwd, input, timeout = 120000 } = {}) {
  const result = spawnSync('git', args, {
    cwd, input, timeout, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new StackPackError(`无法执行 git：${result.error.message}`, 'STACK_GIT');
  if (result.status !== 0) {
    throw new StackPackError(`git ${args.join(' ')} 失败：${result.stderr?.toString() || ''}`, 'STACK_GIT');
  }
  return result.stdout;
}

function listTreeEntries(repoGit, commit, packPath) {
  const out = gitRun(['ls-tree', '-r', '-z', commit, '--', packPath], { cwd: repoGit });
  const prefix = `${packPath}/`;
  return out.split('\0').filter(Boolean).map((item) => {
    const tab = item.indexOf('\t');
    const [mode, type, hash] = item.slice(0, tab).split(/\s+/);
    const full = item.slice(tab + 1);
    return { mode, type, hash, full, rel: full.startsWith(prefix) ? full.slice(prefix.length) : null };
  }).filter((entry) => entry.rel !== null);
}

function readBlobs(repoGit, hashes) {
  const unique = [...new Set(hashes)];
  if (!unique.length) return new Map();
  const buf = gitRunBuffer(['cat-file', '--batch'], {
    cwd: repoGit,
    input: `${unique.join('\n')}\n`,
  });
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const [sha, type, sizeText] = buf.slice(pos, nl).toString('utf8').split(' ');
    const size = Number(sizeText);
    const start = nl + 1;
    if (type !== 'blob' || !Number.isFinite(size)) {
      pos = start;
      continue;
    }
    out.set(sha, buf.subarray(start, start + size));
    pos = start + size + 1;
  }
  return out;
}

/** 先取大小再做限额检查，避免把超大 blob 整个读进内存。 */
function blobSizes(repoGit, hashes) {
  const unique = [...new Set(hashes)];
  if (!unique.length) return new Map();
  const out = gitRun(['cat-file', '--batch-check'], {
    cwd: repoGit,
    input: `${unique.join('\n')}\n`,
  });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, type, sizeText] = line.split(' ');
    if (type === 'blob' && Number.isFinite(Number(sizeText))) map.set(sha, Number(sizeText));
  }
  return map;
}

/** 读取 commit 中的单个文件（用于 index.json），不检出工作树。 */
export function readFileAtCommit({ repoGit, commit, file }) {
  const value = String(file ?? '').replace(/\\/g, '/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
    throw new StackPackError(`非法文件路径：${file}`, 'STACK_PATH');
  }
  return gitRun(['show', `${commit}:${value}`], { cwd: repoGit });
}

function snapshotPaths(cacheRoot, commit, packId) {
  const dir = join(cacheRoot, 'snapshots', commit);
  return {
    dir,
    snapshotDir: join(dir, packId),
    metaFile: join(dir, `${packId}.meta.json`),
  };
}

/** `ls-tree -- <path>` 也会接受越界路径，必须在进入 git 前拒绝。 */
function safePackPath(packPath) {
  const value = String(packPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = value.split('/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new StackPackError(`非法包路径：${packPath}`, 'STACK_PATH');
  }
  return value;
}

export function verifySnapshot({ snapshotDir, metaFile, packId, commit }) {
  if (!existsSync(metaFile) || !existsSync(snapshotDir)) return false;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    return false;
  }
  if (meta.schemaVersion !== 1 || meta.commit !== commit || meta.packId !== packId) return false;
  try {
    const pack = readPackFromDir(snapshotDir, { packId });
    if (pack.files.length !== Object.keys(meta.files || {}).length) return false;
    return pack.files.every((file) => meta.files[file.rel] === file.hash);
  } catch {
    return false;
  }
}

export function materializeSnapshot({
  repoGit, commit, packId, packPath, cacheRoot,
  offline = false, loaderFiles = null, pluginVersion = null,
}) {
  const safePath = safePackPath(packPath);
  const paths = snapshotPaths(cacheRoot, commit, packId);
  ensureDir(paths.dir);
  const lockFile = join(cacheRoot, 'locks', `snapshot-${commit}-${packId}.lock`);
  return withFileLock(lockFile, () => {
    if (verifySnapshot({ ...paths, commit, packId })) {
      const pack = readPackFromDir(paths.snapshotDir, { packId, loaderFiles, pluginVersion });
      return { ...paths, pack };
    }
    // 设计 §5.3：offline 只读快照。不能落到 git 对象读取，
    // 部分克隆缺 blob 时 cat-file 会隐式联网。
    if (offline) {
      throw new StackPackError(`离线模式下没有可用快照：${commit.slice(0, 8)}/${packId}`, 'STACK_OFFLINE');
    }
    const staging = join(paths.dir, `.${packId}.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      const entries = listTreeEntries(repoGit, commit, safePath);
      if (!entries.length) throw new StackPackError(`commit 中没有包路径：${safePath}`, 'STACK_PACK');
      if (entries.length > PACK_LIMITS.files) throw new StackPackError('包内文件超过 500 个', 'STACK_SIZE');
      for (const entry of entries) {
        if (entry.mode === '120000' || entry.mode === '160000' || entry.type !== 'blob') {
          throw new StackPackError(`包内不允许符号链接或子模块：${entry.rel}`, 'STACK_PATH');
        }
      }
      // 先用 --batch-check 拿大小：超限必须在读取内容之前拒绝。
      const sizes = blobSizes(repoGit, entries.map((entry) => entry.hash));
      let total = 0;
      for (const entry of entries) {
        const size = sizes.get(entry.hash);
        if (!Number.isFinite(size)) throw new StackPackError(`读取 blob 大小失败：${entry.rel}`, 'STACK_GIT');
        if (size > PACK_LIMITS.fileBytes) {
          throw new StackPackError(`单文件超过 1 MiB：${entry.rel}`, 'STACK_SIZE');
        }
        total += size;
        if (total > PACK_LIMITS.packBytes) throw new StackPackError('整包超过 10 MiB', 'STACK_SIZE');
      }
      const blobs = readBlobs(repoGit, entries.map((entry) => entry.hash));
      for (const entry of entries) {
        const data = blobs.get(entry.hash);
        if (!data) throw new StackPackError(`读取 blob 失败：${entry.rel}`, 'STACK_GIT');
        const text = data.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(data)) {
          throw new StackPackError(`不是 UTF-8 文本：${entry.rel}`, 'STACK_ENCODING');
        }
        const abs = join(staging, ...entry.rel.split('/'));
        ensureDir(dirname(abs));
        writeAtomic(abs, text);
      }
      const pack = readPackFromDir(staging, { packId, loaderFiles, pluginVersion });
      const meta = {
        schemaVersion: 1,
        commit,
        packId,
        files: Object.fromEntries(pack.files.map((file) => [file.rel, file.hash])),
      };
      rmSync(paths.snapshotDir, { recursive: true, force: true });
      // meta 在包目录外，且先于 rename 写：rename 失败时 verify 会发现快照缺失并重建。
      writeAtomic(paths.metaFile, `${JSON.stringify(meta, null, 2)}\n`);
      renameSync(staging, paths.snapshotDir);
      return { ...paths, pack };
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }, { failClosed: true });
}

export function listSnapshots(cacheRoot) {
  const root = join(cacheRoot, 'snapshots');
  if (!existsSync(root)) return [];
  const out = [];
  for (const commit of readdirSync(root)) {
    const dir = join(root, commit);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.meta.json')) continue;
      const packId = name.slice(0, -'.meta.json'.length);
      const snapshotDir = join(dir, packId);
      const metaFile = join(dir, name);
      if (!existsSync(snapshotDir)) continue;
      out.push({ commit, packId, snapshotDir, metaFile, mtimeMs: statSync(metaFile).mtimeMs });
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-fetch.test.mjs`
Expected: PASS，6 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-fetch.mjs tests/stack-fetch.test.mjs
git commit -m "feat(stack): 实现不可变快照与完整性校验"
```

---

### Task 9: 更新三方合并与恢复采纳

**Files:**
- Modify: `scripts/lib/stack-install.mjs`
- Test: `tests/stack-install.test.mjs`

**Interfaces:**
- Consumes: `mergeTexts`、`contentHash`、`targetSnapshot`、`commitStagedTree`、`dropHubOwnership`、`readLock`、`writeLock`。
- Produces:
  - `planPackUpdate({ root, installedAs, pack }): { ops, warnings }`
  - `applyPackUpdate({ root, installedAs, pack, source, sources, force?, noGen?, generate?, onWarn? }): { ops }`
  - `adoptExisting({ root, installedAs, pack, source, sources, onWarn? }): void`

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-install.test.mjs 追加
import { applyPackUpdate, planPackUpdate, adoptExisting } from '../scripts/lib/stack-install.mjs';

test('更新合并本地改动、保留未改文件并删除包删除的干净文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-update-'));
  try {
    const source = { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' };
    const v1 = packOf({ '_shared.md': '# shared\n', 'plan.md': 'a\nb\nc\n', 'old.md': '# old\n' });
    applyInstall({ root, installedAs: 'java-spring', pack: v1, source, sources: { schemaVersion: 1, packs: {} }, noGen: true });
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'a\nLOCAL\nc\n');

    const v2 = packOf({ '_shared.md': '# shared\n', 'plan.md': 'a\nb\nC2\n' });
    const plan = planPackUpdate({ root, installedAs: 'java-spring', pack: v2, sources: readSources(root) });
    assert.ok(plan.ops.some((op) => op.rel === 'old.md' && op.type === 'delete'));
    assert.ok(plan.ops.some((op) => op.rel === 'plan.md' && op.type === 'write'));

    applyPackUpdate({ root, installedAs: 'java-spring', pack: v2, source, sources: readSources(root), noGen: true });
    const merged = readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8');
    assert.match(merged, /LOCAL/);
    assert.match(merged, /C2/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'old.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('包删除本地改过的文件时保留并给警告', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-update-keep-'));
  try {
    const source = { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' };
    applyInstall({
      root, installedAs: 'java-spring', source, noGen: true,
      pack: packOf({ '_shared.md': '# shared\n', 'old.md': '# old\n' }),
      sources: { schemaVersion: 1, packs: {} },
    });
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'old.md'), '# local edit\n');
    const plan = planPackUpdate({
      root, installedAs: 'java-spring', pack: packOf({ '_shared.md': '# shared\n' }), sources: readSources(root),
    });
    assert.ok(plan.ops.some((op) => op.rel === 'old.md' && op.type === 'keep'));
    assert.match(plan.warnings.join('\n'), /本地改过/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adoptExisting 为内容一致目录补账本与 bases', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-adopt-'));
  try {
    const pack = packOf({ '_shared.md': '# shared\n' });
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# shared\n');
    adoptExisting({
      root, installedAs: 'java-spring', pack,
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
    });
    assert.equal(readSources(root).packs['java-spring'].files['.claude/hub/stacks/java-spring/_shared.md'].base, contentHash('# shared\n'));
    assert.equal(readFileSync(join(root, '.claude', '.stack-bases', 'java-spring', '_shared.md'), 'utf8'), '# shared\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-install.test.mjs`
Expected: FAIL，`planPackUpdate is not a function`。

- [ ] **Step 3: 实现合并与采纳**

```js
// scripts/lib/stack-install.mjs 追加
import { mergeTexts } from './upstream.mjs';
// 同时把 writeSources 加入 Task 5 已有的 stack-ledger 导入：
// dropHubOwnership, readLock, readSources, stackPaths, writeLock, writeSources

function readTreeTexts(dir) {
  const map = new Map();
  for (const file of listTree(dir)) map.set(file.rel, readFileSync(file.abs, 'utf8'));
  return map;
}

export function planPackUpdate({ root, installedAs, pack }) {
  const paths = stackPaths(root);
  const current = readTreeTexts(paths.stackDir(installedAs));
  const base = readTreeTexts(paths.basesDir(installedAs));
  const theirs = new Map(pack.files.map((file) => [file.rel, file.text]));
  const rels = [...new Set([...current.keys(), ...base.keys(), ...theirs.keys()])].sort();
  const ops = [];
  const warnings = [];
  for (const rel of rels) {
    const b = base.get(rel);
    const l = current.get(rel);
    const t = theirs.get(rel);
    if (t !== undefined && l === undefined && b === undefined) {
      ops.push({ type: 'write', rel, text: t });
    } else if (t !== undefined && l === undefined) {
      ops.push({ type: 'missing', rel });
    } else if (t !== undefined && b === undefined) {
      ops.push(l === t ? { type: 'same', rel } : { type: 'conflict', rel, reason: '本地已有同名文件' });
    } else if (t !== undefined) {
      if (l === b) ops.push({ type: 'write', rel, text: t });
      else if (l === t) ops.push({ type: 'same', rel });
      else {
        const merged = mergeTexts(b, l, t);
        if (merged.ok) ops.push({ type: 'write', rel, text: merged.content, merged: true });
        else ops.push({ type: 'conflict', rel, reason: merged.conflicts ? '三方合并冲突' : (merged.error || '合并失败') });
      }
    } else if (b !== undefined) {
      if (l === undefined) ops.push({ type: 'missing', rel });
      else if (l === b) ops.push({ type: 'delete', rel });
      else {
        ops.push({ type: 'keep', rel });
        warnings.push(`${rel}：包已删除但本地改过，保留本地文件`);
      }
    } else {
      ops.push({ type: 'orphan', rel });
    }
  }
  return { ops, warnings };
}

function stageCurrentTree(root, installedAs, staged, ops) {
  const current = stackPaths(root).stackDir(installedAs);
  if (existsSync(current)) {
    cpSync(current, staged, { recursive: true });
  } else {
    ensureDir(staged);
  }
  for (const op of ops) {
    const abs = join(staged, ...op.rel.split('/'));
    if (op.type === 'write') {
      ensureDir(dirname(abs));
      writeAtomic(abs, op.text);
    } else if (op.type === 'delete') {
      rmSync(abs, { force: true });
    } else if (op.type === 'conflict' && existsSync(abs)) {
      cpSync(abs, `${abs}.bak-${Date.now()}`);
    }
  }
}

export function applyPackUpdate({
  root, installedAs, pack, source, sources, force = false,
  noGen = false, generate = null, onWarn = () => {},
}) {
  const paths = stackPaths(root);
  const plan = planPackUpdate({ root, installedAs, pack });
  for (const warning of plan.warnings) onWarn(warning);
  for (const op of plan.ops) {
    if (op.type === 'conflict') onWarn(`${op.rel}：${op.reason}；保留本地并写入 .bak`);
  }
  const stageRoot = join(paths.stagingRoot, tag());
  const stagedTarget = join(stageRoot, 'target');
  const stagedBases = join(stageRoot, 'bases');
  try {
    stageCurrentTree(root, installedAs, stagedTarget, plan.ops);
    writePackTree(stagedBases, pack);
    // local 必须取 staging 的实际内容：冲突与缺失文件不能用包内哈希冒充干净写入。
    const localHashes = hashTree(stagedTarget, pack.files.map((file) => file.rel));
    const record = ledgerRecord({ installedAs, pack, source, localHashes });
    commitStagedTree({
      root, installedAs, source, pack, record, stagedTarget, stagedBases, force, onWarn,
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  if (!noGen && generate) generate(root);
  return { ops: plan.ops };
}

export function adoptExisting({ root, installedAs, pack, source, sources, onWarn = () => {} }) {
  const paths = stackPaths(root);
  const target = paths.stackDir(installedAs);
  const bases = paths.basesDir(installedAs);
  const localHashes = hashTree(target, pack.files.map((file) => file.rel));
  const absent = pack.files.filter((file) => localHashes.get(file.rel) === null);
  if (absent.length) throw new Error(`目标目录缺少文件，不能采纳：${absent.map((file) => file.rel).join('、')}`);

  const stageRoot = join(paths.stagingRoot, tag());
  const stagedBases = join(stageRoot, 'bases');
  const trash = join(paths.trashRoot, tag(), `${installedAs}-bases`);
  writePackTree(stagedBases, pack);
  const tx = { movedOld: false, placedNew: false };
  try {
    if (existsSync(bases)) {
      ensureDir(dirname(trash));
      renameSync(bases, trash);
      tx.movedOld = true;
    }
    ensureDir(dirname(bases));
    renameSync(stagedBases, bases);
    tx.placedNew = true;
    // 账本是提交点：bases 换入后写账本，失败则把旧 bases 放回。
    const latest = readSources(root);
    writeSources(root, {
      ...latest,
      schemaVersion: 1,
      packs: { ...latest.packs, [installedAs]: ledgerRecord({ installedAs, pack, source, localHashes }) },
    });
  } catch (err) {
    if (tx.placedNew) rmSync(bases, { recursive: true, force: true });
    if (tx.movedOld) {
      ensureDir(dirname(bases));
      renameSync(trash, bases);
    }
    throw err;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  if (tx.movedOld) rmSync(dirname(trash), { recursive: true, force: true });

  try {
    dropHubOwnership(root, installedAs);
  } catch (err) {
    onWarn(`owner 转移失败：${err.message}；运行 devflow doctor 检查`);
  }
  try {
    const lock = readLock(root);
    if (source.type === 'git') lock.packs[installedAs] = lockEntryFor({ installedAs, source, pack });
    else delete lock.packs[installedAs];
    writeLock(root, lock);
  } catch (err) {
    onWarn(`写入 stack-lock.yaml 失败：${err.message}；运行 devflow stack lock 重建`);
  }
}
```

`Task 5` 的 `node:fs` 导入已包含 `cpSync`；`listTree` 是 Task 4 在本文件内定义的函数，无需额外导入。只需按上面注释把 `writeSources` 补进已有的 `stack-ledger` 导入。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-install.test.mjs`
Expected: PASS，10 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/stack-install.mjs tests/stack-install.test.mjs
git commit -m "feat(stack): 实现三方合并更新与恢复采纳"
```

---

## Phase C：CLI / doctor / sync 集成

### Task 10: `add --repo`、`list`、`lock`、`cache gc`

**Files:**
- Modify: `scripts/hub-stack.mjs`
- Test: `tests/stack-cli.test.mjs`

**Interfaces:**
- Consumes: `ensureRepo`、`resolveCommit`、`fetchCommit`、`materializeSnapshot`、`readLock`、`writeLock`。
- Produces: `add --repo`、`list`、`lock`、`cache gc` 子命令。

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-cli.test.mjs 追加
import { readdirSync, utimesSync } from 'node:fs';

function makeGitStackRepo(base) {
  const repo = join(base, 'git-stacks');
  mkdirSync(repo, { recursive: true });
  const g = (args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
  };
  g(['init', '-b', 'main']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'test']);
  const text = '# shared\n';
  const packDir = join(repo, 'stacks', 'java-spring');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, '_shared.md'), text);
  writeFileSync(join(packDir, 'stack.json'), JSON.stringify({
    name: 'java-spring', version: '1.2.0', minDevflow: '>=1.7.0',
    detects: ['java-maven'], files: { '_shared.md': contentHash(text) },
  }));
  writeFileSync(join(repo, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    packs: { 'java-spring': { path: 'stacks/java-spring', detects: ['java-maven'] } },
  }));
  g(['add', '.']);
  g(['commit', '-m', 'init']);
  return repo;
}

test('stack add --repo 写入快照与 lock，list/status 可读', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-git-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', [
      'add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen',
    ], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const lock = readFileSync(join(root, '.claude', 'hub', 'stack-lock.yaml'), 'utf8');
    assert.match(lock, /commit:/);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'].source, 'git');
    assert.match(ledger.packs['java-spring'].commit, /^[0-9a-f]{40}$/);

    const list = run('hub-stack.mjs', ['list', '--root', root], root, env);
    assert.match(list.stdout, /java-spring/);
    const status = run('hub-stack.mjs', ['status', '--root', root, '--json'], root, env);
    assert.equal(JSON.parse(status.stdout)[0].installedAs, 'java-spring');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack lock 从本地账本重建可复现 lock', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-lock-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    let res = run('hub-stack.mjs', ['lock', '--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /跳过本地来源/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cache gc 默认 dry-run，--apply 才删除过期快照', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-gc-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    const metas = [];
    const snapshots = join(cache, 'snapshots');
    for (const commit of readdirSync(snapshots)) {
      for (const name of readdirSync(join(snapshots, commit))) {
        if (name.endsWith('.meta.json')) metas.push(join(snapshots, commit, name));
      }
    }
    assert.equal(metas.length, 1);
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(metas[0], old, old);
    const dry = run('hub-stack.mjs', ['cache', 'gc', '--root', root, '--keep-days', '1'], root, env);
    assert.match(dry.stdout, /将删除|dry-run/);
    assert.equal(existsSync(metas[0]), true);
    run('hub-stack.mjs', ['cache', 'gc', '--root', root, '--keep-days', '1', '--apply'], root, env);
    assert.equal(existsSync(metas[0]), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-cli.test.mjs`
Expected: FAIL，`add --repo` 仍返回“需要 bare 缓存支持”。

- [ ] **Step 3: 扩展 CLI**

```js
// scripts/hub-stack.mjs：把以下名称加入现有导入
// node:fs：readFileSync、rmSync（existsSync 已在 Task 6 导入）
// node:path：join 已在 Task 6 导入
// common：contentHash
// stack-pack：validateIndex
import {
  ensureRepo, fetchCommit, listSnapshots, materializeSnapshot, readFileAtCommit,
  refreshRef, resolveCommit, stackCacheRoot,
} from './lib/stack-fetch.mjs';
import { readLock, stackPaths, writeLock } from './lib/stack-ledger.mjs';

function allowLocalRepo() {
  return process.env.DEVFLOW_STACK_ALLOW_LOCAL_REPO === '1';
}

function remoteIndex(repoGit, commit) {
  return validateIndex(JSON.parse(readFileAtCommit({ repoGit, commit, file: 'index.json' })));
}

function remoteEntry(index, packId) {
  const entry = index.packs[packId];
  if (!entry) throw new Error(`index.json 中没有包：${packId}`);
  const value = String(entry.path ?? '').replace(/\\/g, '/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
    throw new Error(`包路径非法：${entry.path}`);
  }
  return entry;
}
```

用下面代码整体替换 `add` 分支：

```js
  if (command === 'add') {
    const repoArg = argValue(argv, '--repo', null) || process.env.DEVFLOW_STACK_REPO || null;
    const from = argValue(argv, '--from', null);
    if (!packId) throw new Error('缺少包名：devflow stack add <packId> [--repo <url>|--from <dir>]');
    if (!!repoArg === !!from) throw new Error('add 必须且只能提供 --repo、--from 或 DEVFLOW_STACK_REPO 之一');
    if (from && (argValue(argv, '--ref', null) || hasFlag(argv, '--offline'))) {
      throw new Error('--from 是本地目录来源，不接受 --ref 或 --offline');
    }
    const offline = hasFlag(argv, '--offline');
    let pack;
    let source;
    let entry;
    if (from) {
      const fromRoot = resolve(from);
      const index = readIndex(fromRoot);
      const resolved = resolveIndexPack(index, packId, fromRoot);
      entry = resolved.entry;
      pack = readPackFromDir(resolved.packDir, {
        packId, indexEntry: entry, loaderFiles: loaderFiles(), pluginVersion: pluginVersionOf(),
      });
      source = { type: 'local', localPath: fromRoot, packId, path: entry.path };
    } else {
      const cacheRoot = stackCacheRoot();
      const info = ensureRepo({ url: repoArg, cacheRoot, offline, allowFile: allowLocalRepo() });
      const ref = argValue(argv, '--ref', 'main');
      if (!offline) refreshRef({ repoGit: info.repoGit, ref });
      const commit = resolveCommit({ repoGit: info.repoGit, ref, offline });
      fetchCommit({ repoGit: info.repoGit, commit, ref, offline });
      const index = remoteIndex(info.repoGit, commit);
      entry = remoteEntry(index, packId);
      const snap = materializeSnapshot({
        repoGit: info.repoGit, commit, packId, packPath: entry.path, cacheRoot, offline,
        loaderFiles: loaderFiles(), pluginVersion: pluginVersionOf(),
      });
      pack = snap.pack;
      source = { type: 'git', repo: repoArg, packId, path: entry.path, ref, commit };
    }
    const installedAs = argValue(argv, '--as', packId);
    if (!isValidStackName(installedAs)) {
      throw new Error(`--as 不是合法的栈名：${installedAs}（只允许 [a-z0-9][a-z0-9_-]*）`);
    }
    for (const warning of pack.warnings) log('warn', `${packId}：${warning}`);
    if (hasFlag(argv, '--dry-run')) {
      log('info', `将安装 ${packId}@${pack.manifest.version} → .claude/hub/stacks/${installedAs}`);
      return { dryRun: true, packId, installedAs };
    }
    const noGen = hasFlag(argv, '--no-gen');
    const result = applyInstall({
      root,
      installedAs,
      pack,
      source,
      sources: readSources(root),
      force: hasFlag(argv, '--force'),
      noGen,
      generate: noGen ? null : runGen,
      onWarn: (message) => log('warn', message),
    });
    log('ok', `已安装 ${packId}@${pack.manifest.version} → .claude/hub/stacks/${installedAs}（${result.action}）`);
    if (!noGen && !declaredStacks(root).has(installedAs)) {
      log('info', `hub.yaml 尚未声明 ${installedAs}；补充 stack: ${installedAs}（或对应子项目的 stack）后再运行 node scripts/devflow-gen.mjs`);
    }
    return result;
  }
```

继续追加子命令：

```js
if (command === 'list') {
  const sources = readSources(root);
  const repoArg = argValue(argv, '--repo', null);
  const installed = Object.values(sources.packs).map((record) => ({
    installedAs: record.installedAs,
    version: record.version,
    commit: record.commit || null,
    source: record.source,
    repo: record.repo || record.localPath,
  }));
  const available = [];
  if (repoArg) {
    const cacheRoot = stackCacheRoot();
    const info = ensureRepo({ url: repoArg, cacheRoot, allowFile: allowLocalRepo() });
    const ref = argValue(argv, '--ref', 'main');
    refreshRef({ repoGit: info.repoGit, ref });
    const commit = resolveCommit({ repoGit: info.repoGit, ref });
    const index = remoteIndex(info.repoGit, commit);
    for (const [id, item] of Object.entries(index.packs)) {
      available.push({ packId: id, title: item.title || id, path: item.path });
    }
  }
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify({ installed, available }, null, 2));
  } else {
    for (const item of installed) {
      log('ok', `${item.installedAs}@${item.version}${item.commit ? ` ${item.commit.slice(0, 8)}` : ' local'}`);
    }
    for (const item of available) log('info', `可用 ${item.packId}：${item.title}`);
  }
  return { installed, available };
}

if (command === 'status') {
  const sources = readSources(root);
  const rows = Object.values(sources.packs).map((record) => {
    const modified = [];
    const missing = [];
    for (const [rel, hashes] of Object.entries(record.files || {})) {
      // 安装时本地就缺失的文件记 local: null，必须继续按缺失报告。
      if (hashes.local === null) {
        missing.push(rel);
        continue;
      }
      const abs = join(root, ...rel.split('/'));
      if (!existsSync(abs)) missing.push(rel);
      else if (contentHash(readFileSync(abs, 'utf8')) !== hashes.local) modified.push(rel);
    }
    return {
      installedAs: record.installedAs,
      version: record.version,
      commit: record.commit || null,
      source: record.source,
      modified: modified.length > 0,
      missing,
      modifiedFiles: modified,
    };
  });
  if (hasFlag(argv, '--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const row of rows) {
      const state = row.modified ? '（已手改）' : '';
      const gap = row.missing.length ? `（缺失 ${row.missing.length}）` : '';
      log(row.modified || row.missing.length ? 'warn' : 'ok',
        `${row.installedAs}@${row.version}${row.commit ? ` ${row.commit.slice(0, 8)}` : ' local'}${state}${gap}`);
    }
  }
  return { rows };
}

if (command === 'lock') {
  const sources = readSources(root);
  const lock = readLock(root);
  const next = { version: 1, packs: {} };
  for (const record of Object.values(sources.packs)) {
    if (record.source !== 'git') {
      log('warn', `跳过本地来源 ${record.installedAs}：不可跨机器复现`);
      continue;
    }
    next.packs[record.installedAs] = {
      installedAs: record.installedAs, repo: record.repo, packId: record.packId,
      path: record.path, ref: record.ref, commit: record.commit, version: record.version,
    };
  }
  // lock 允许其他工具写入未知顶层字段，重建时原样保留。
  for (const [key, value] of Object.entries(lock)) {
    if (key !== 'version' && key !== 'packs') next[key] = value;
  }
  if (hasFlag(argv, '--dry-run')) {
    log('info', `将写入 ${Object.keys(next.packs).length} 个 lock 条目`);
  } else {
    writeLock(root, next);
    log('ok', `已写入 .claude/hub/stack-lock.yaml（${Object.keys(next.packs).length} 个包）`);
  }
  return { packs: next.packs };
}

if (command === 'cache') {
  const [, sub] = positionals(argv);
  if (sub !== 'gc') throw new Error(`未知 cache 子命令：${sub || ''}`);
  const keepDays = Number(argValue(argv, '--keep-days', '30'));
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error('--keep-days 必须是正整数');
  const cacheRoot = stackCacheRoot();
  const cutoff = Date.now() - keepDays * 86400000;
  const stale = listSnapshots(cacheRoot).filter((item) => item.mtimeMs < cutoff);
  for (const item of stale) {
    log('info', `${hasFlag(argv, '--apply') ? '删除' : '将删除'} ${item.packId}@${item.commit.slice(0, 8)}`);
  }
  if (!stale.length) log('ok', `没有超过 ${keepDays} 天的快照`);
  if (hasFlag(argv, '--apply')) {
    for (const item of stale) {
      rmSync(item.snapshotDir, { recursive: true, force: true });
      rmSync(item.metaFile, { force: true });
    }
    log('ok', `已删除 ${stale.length} 个过期快照；其他项目可能需要重新联网拉取`);
  } else if (stale.length) {
    log('info', 'dry-run：加 --apply 才会删除');
  }
  return { stale: stale.length };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-cli.test.mjs`
Expected: PASS，6 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/hub-stack.mjs scripts/lib/stack-fetch.mjs tests/stack-cli.test.mjs
git commit -m "feat(stack): 支持远程安装、list、lock 与缓存清理"
```

---

### Task 11: `update`、`restore`、`remove`

**Files:**
- Modify: `scripts/hub-stack.mjs`
- Test: `tests/stack-cli.test.mjs`

**Interfaces:**
- Consumes: `applyPackUpdate`、`adoptExisting`、`readLock`、`stackPaths`、`loadHub`。
- Produces: `update [<installedAs>|--all]`、`restore`、`remove <installedAs>`。

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-cli.test.mjs 追加
test('update 推进 ref 并保留本地改动，restore 按 lock 恢复', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-update-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'local.md'), '# local\n');
    writeFileSync(join(repo, 'stacks', 'java-spring', '_shared.md'), '# shared v2\n');
    const manifest = JSON.parse(readFileSync(join(repo, 'stacks', 'java-spring', 'stack.json'), 'utf8'));
    manifest.files['_shared.md'] = contentHash('# shared v2\n');
    writeFileSync(join(repo, 'stacks', 'java-spring', 'stack.json'), JSON.stringify(manifest));
    const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    g(['add', '.']);
    g(['commit', '-m', 'v2']);
    const update = run('hub-stack.mjs', ['update', 'java-spring', '--root', root, '--no-gen'], root, env);
    assert.equal(update.status, 0, update.stderr + update.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), /v2/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'local.md')), true);

    rmSync(join(root, '.claude', 'hub', 'stacks', 'java-spring'), { recursive: true, force: true });
    const restore = run('hub-stack.mjs', ['restore', '--root', root, '--no-gen'], root, env);
    assert.equal(restore.status, 0, restore.stderr + restore.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), /v2/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('remove 在被 hub.yaml 引用时拒绝，--keep 允许', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-remove-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
    writeFileSync(hubFile, readFileSync(hubFile, 'utf8').replace('stages:', 'stack: java-spring\nstages:'));
    const refused = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--no-gen'], root);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /引用/);
    const forced = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--force', '--no-gen'], root);
    assert.notEqual(forced.status, 0);
    assert.match(forced.stderr, /不接受 --force/);
    const kept = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--keep', '--no-gen'], root);
    assert.equal(kept.status, 0, kept.stderr + kept.stdout);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), true);
    assert.equal(JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8')).packs['java-spring'], undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-cli.test.cjs` → 使用正确命令 `node --test tests/stack-cli.test.mjs`
Expected: FAIL，`暂不支持的子命令：update`。

- [ ] **Step 3: 实现三个子命令**

```js
// scripts/hub-stack.mjs 追加
function pruneEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

/** 把账本记录还原成可直接安装的 pack 与 source；本地来源重新读 localPath。 */
function loadRecordSource(record, refOverride, offline) {
  if (record.source === 'local') {
    if (refOverride) throw new Error(`${record.installedAs} 是本地来源，不支持 --ref`);
    const fromRoot = resolve(record.localPath);
    const index = readIndex(fromRoot);
    const resolved = resolveIndexPack(index, record.packId, fromRoot);
    const pack = readPackFromDir(resolved.packDir, {
      packId: record.packId, indexEntry: resolved.entry,
      loaderFiles: loaderFiles(), pluginVersion: pluginVersionOf(),
    });
    return {
      pack,
      source: { type: 'local', localPath: fromRoot, packId: record.packId, path: resolved.entry.path },
    };
  }
  const cacheRoot = stackCacheRoot();
  const info = ensureRepo({ url: record.repo, cacheRoot, offline, allowFile: allowLocalRepo() });
  const ref = refOverride || record.ref || 'main';
  // 先刷新 ref 再解析：否则缓存里的旧 ref 会让 update 原地不动。
  if (!offline) refreshRef({ repoGit: info.repoGit, ref });
  const commit = resolveCommit({ repoGit: info.repoGit, ref, offline });
  const index = remoteIndex(info.repoGit, commit);
  const entry = remoteEntry(index, record.packId);
  const snap = materializeSnapshot({
    repoGit: info.repoGit, commit, packId: record.packId, packPath: entry.path, cacheRoot, offline,
    loaderFiles: loaderFiles(), pluginVersion: pluginVersionOf(),
  });
  return {
    pack: snap.pack,
    source: { type: 'git', repo: record.repo, packId: record.packId, path: entry.path, ref, commit },
  };
}

if (command === 'update') {
  const sources = readSources(root);
  const all = hasFlag(argv, '--all');
  if (!packId && !all) throw new Error('update 需要 <installedAs> 或 --all');
  const names = all ? Object.keys(sources.packs) : [packId];
  const dryRun = hasFlag(argv, '--dry-run');
  const noGen = hasFlag(argv, '--no-gen');
  let changed = 0;
  for (const name of names) {
    const record = sources.packs[name];
    if (!record) throw new Error(`未安装：${name}`);
    const { pack, source } = loadRecordSource(
      record, argValue(argv, '--ref', null), hasFlag(argv, '--offline'),
    );
    if (dryRun) {
      // 设计第 9 节要求 dry-run 输出每个文件的动作，而不是只报“将更新”。
      const labels = {
        write: '写入', delete: '删除', keep: '保留', missing: '本地缺失',
        conflict: '冲突', orphan: '额外文件', same: '不变',
      };
      const plan = planPackUpdate({ root, installedAs: name, pack });
      for (const op of plan.ops) {
        log('info', `${name} ${op.merged ? '合并写入' : labels[op.type] || op.type} ${op.rel}`);
      }
      for (const warning of plan.warnings) log('warn', warning);
      log('info', `将更新 ${name} → ${source.commit ? source.commit.slice(0, 8) : source.localPath}`);
      continue;
    }
    applyPackUpdate({
      root, installedAs: name, pack, source, sources: readSources(root),
      force: hasFlag(argv, '--force'), noGen, generate: noGen ? null : runGen,
      onWarn: (message) => log('warn', message),
    });
    log('ok', `已更新 ${name} → ${source.commit ? source.commit.slice(0, 8) : 'local'}`);
    changed += 1;
  }
  if (!dryRun && changed && noGen) log('info', '--no-gen：跳过 gen；运行 node scripts/devflow-gen.mjs 刷新投影');
  return { updated: dryRun ? [] : names };
}

if (command === 'restore') {
  const lock = readLock(root);
  if (!Object.keys(lock.packs).length) {
    log('info', '没有可恢复的包：stack-lock.yaml 为空或不存在');
  }
  const offline = hasFlag(argv, '--offline');
  const force = hasFlag(argv, '--force');
  const dryRun = hasFlag(argv, '--dry-run');
  const noGen = hasFlag(argv, '--no-gen');
  let changed = 0;
  for (const [installedAs, entry] of Object.entries(lock.packs)) {
    const info = ensureRepo({
      url: entry.repo, cacheRoot: stackCacheRoot(), offline, allowFile: allowLocalRepo(),
    });
    if (!offline) fetchCommit({ repoGit: info.repoGit, commit: entry.commit, ref: entry.ref });
    const snap = materializeSnapshot({
      repoGit: info.repoGit, commit: entry.commit, packId: entry.packId, packPath: entry.path,
      cacheRoot: stackCacheRoot(), offline,
      loaderFiles: loaderFiles(), pluginVersion: pluginVersionOf(),
    });
    const source = {
      type: 'git', repo: entry.repo, packId: entry.packId,
      path: entry.path, ref: entry.ref, commit: entry.commit,
    };
    const state = targetSnapshot(root, installedAs, snap.pack);
    const mode = !state.exists ? 'restore' : (state.matches ? 'adopt' : (force ? 'force' : 'modified'));
    if (dryRun) {
      log('info', `将处理 ${installedAs}：${mode}`);
      continue;
    }
    if (mode === 'restore') {
      applyInstall({
        root, installedAs, pack: snap.pack, source,
        sources: readSources(root), force, noGen, generate: noGen ? null : runGen,
      });
      log('ok', `已恢复 ${installedAs}@${entry.version}`);
      changed += 1;
    } else if (mode === 'adopt') {
      adoptExisting({ root, installedAs, pack: snap.pack, source, sources: readSources(root), onWarn: (m) => log('warn', m) });
      log('ok', `已采纳一致目录 ${installedAs}`);
      changed += 1;
    } else if (mode === 'force') {
      applyInstall({
        root, installedAs, pack: snap.pack, source,
        sources: readSources(root), force: true, noGen, generate: noGen ? null : runGen,
      });
      log('ok', `已强制恢复 ${installedAs}`);
      changed += 1;
    } else {
      const paths = stackPaths(root);
      const stageRoot = join(paths.stagingRoot, `${process.pid}-${Date.now()}`);
      const stagedBases = join(stageRoot, 'bases');
      writePackTree(stagedBases, snap.pack);
      const bases = paths.basesDir(installedAs);
      const trash = join(paths.trashRoot, `${process.pid}-${Date.now()}`, `${installedAs}-bases`);
      let movedOld = false;
      let placedNew = false;
      try {
        // 与安装事务同一顺序：旧 bases 先入 trash，新 bases 换入，账本是提交点。
        if (existsSync(bases)) {
          ensureDir(dirname(trash));
          renameSync(bases, trash);
          movedOld = true;
        }
        ensureDir(dirname(bases));
        renameSync(stagedBases, bases);
        placedNew = true;
        const localHashes = hashTree(
          paths.stackDir(installedAs), snap.pack.files.map((file) => file.rel),
        );
        const latest = readSources(root);
        writeSources(root, {
          ...latest,
          schemaVersion: 1,
          packs: {
            ...latest.packs,
            [installedAs]: ledgerRecord({ installedAs, pack: snap.pack, source, localHashes }),
          },
        });
      } catch (err) {
        if (placedNew) rmSync(bases, { recursive: true, force: true });
        if (movedOld) {
          ensureDir(dirname(bases));
          renameSync(trash, bases);
        }
        throw err;
      } finally {
        rmSync(stageRoot, { recursive: true, force: true });
      }
      if (movedOld) rmSync(dirname(trash), { recursive: true, force: true });
      log('warn', `${installedAs} 与 lock 内容不同：保留本地并标记 modified；确认覆盖加 --force`);
      changed += 1;
    }
  }
  const localOnly = Object.keys(readSources(root).packs).filter((name) => !lock.packs[name]);
  if (localOnly.length) {
    log('warn', `${localOnly.join('、')} 未在 stack-lock.yaml 中，保留不删除；不能跨机器恢复，运行 devflow stack lock 或重新 add`);
  }
  if (!dryRun && changed && noGen) log('info', '--no-gen：跳过 gen；运行 node scripts/devflow-gen.mjs 刷新投影');
  return { restored: dryRun ? [] : Object.keys(lock.packs) };
}

if (command === 'remove') {
  const installedAs = packId;
  if (!installedAs) throw new Error('remove 需要 <installedAs>');
  // 设计第 11 节：删除不接受 --force，避免绕过引用检查制造 gen 必然报错的状态。
  if (hasFlag(argv, '--force')) {
    throw new Error('remove 不接受 --force；被引用时请先解除 hub.yaml 声明，或用 --keep 保留目录');
  }
  const keep = hasFlag(argv, '--keep');
  const purge = hasFlag(argv, '--purge');
  if (keep && purge) throw new Error('--keep 与 --purge 不能同时使用');
  if (!keep && declaredStacks(root).has(installedAs)) {
    throw new Error(`${installedAs} 仍被 hub.yaml 引用；先手工解除声明，或使用 --keep`);
  }
  const sources = readSources(root);
  if (!sources.packs[installedAs]) throw new Error(`未安装：${installedAs}`);
  const paths = stackPaths(root);
  const target = paths.stackDir(installedAs);
  const dryRun = hasFlag(argv, '--dry-run');
  const noGen = hasFlag(argv, '--no-gen');
  if (dryRun) {
    log('info', `将移除 ${installedAs}${keep ? '（保留目录）' : purge ? '（保留手改与额外文件）' : '（目录入 trash）'}`);
    return { removed: installedAs, keep };
  }
  if (!keep) {
    if (purge) {
      for (const [rel, hashes] of Object.entries(sources.packs[installedAs].files || {})) {
        // 只删除“本地未改且本机基线也一致”的文件，手改与额外文件保留。
        if (hashes.local === null || hashes.local !== hashes.base) continue;
        const abs = join(root, ...rel.split('/'));
        if (existsSync(abs) && contentHash(readFileSync(abs, 'utf8')) === hashes.local) {
          rmSync(abs, { force: true });
        }
      }
      pruneEmptyDirs(target);
    } else if (existsSync(target)) {
      const trash = join(paths.trashRoot, `${process.pid}-${Date.now()}`, installedAs);
      ensureDir(dirname(trash));
      renameSync(target, trash);
    }
  }
  rmSync(paths.basesDir(installedAs), { recursive: true, force: true });
  const next = { ...sources, packs: { ...sources.packs } };
  delete next.packs[installedAs];
  writeSources(root, next);
  // 只有原本存在 lock 时才回写，避免 remove 制造一个空的 stack-lock.yaml。
  if (existsSync(paths.lock)) {
    const lock = readLock(root);
    delete lock.packs[installedAs];
    writeLock(root, lock);
  }
  if (!noGen) runGen(root);
  log('ok', `已移除 ${installedAs}${keep ? '（保留目录）' : ''}`);
  if (keep) log('info', `${installedAs} 已成为普通栈目录，不再受 pack 更新；后续 sync 可能接管`);
  return { removed: installedAs, keep };
}
```

`hub-stack.mjs` 需要补 `applyPackUpdate`、`planPackUpdate`、`adoptExisting`、`targetSnapshot`、`ledgerRecord`、`hashTree`、`writePackTree`（来自 `stack-install.mjs`），`writeSources`（来自 `stack-ledger.mjs`），以及 `readdirSync`、`readFileSync`、`renameSync`、`rmSync`、`ensureDir`、`dirname` 导入。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-cli.test.mjs`
Expected: PASS，8 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/hub-stack.mjs tests/stack-cli.test.mjs
git commit -m "feat(stack): 支持更新、恢复与删除"
```

---

### Task 12: `sync` 跳过受管栈并 fail closed

**Files:**
- Modify: `scripts/hub-sync.mjs:70-190, 250-360`
- Test: `tests/stack-integration.test.mjs`

**Interfaces:**
- Consumes: `readSources`、`managedStackPrefixes`。
- Produces: sync 对受管路径不做 action；受管路径下的旧 `.hub-sources.json` 记录不进入 `removed`（`known` 之外再用受管前缀过滤）；账本损坏时退出 1。

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-integration.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function makeProject(base) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
  const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return root;
}

test('sync 跳过受管栈路径，不用模板库覆盖 pack', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# pack content\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0', files: {},
        },
      },
    }));
    // 使用独立 plugin fixture，避免修改仓库模板。
    // 版本必须满足 makeProject 写出的 requiresPlugin（^1.7.0），否则 sync 会在版本门禁处失败。
    const fixture = join(base, 'plugin');
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fixture, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version: '1.7.0' }));
    mkdirSync(join(fixture, 'templates', 'stages', 'req'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stages', 'req', 'SKILL.md'), '---\nname: req\ndescription: req\n---\n\nreq\n');
    mkdirSync(join(fixture, 'templates', 'stacks', 'java-spring'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stacks', 'java-spring', '_shared.md'), '# template content\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', fixture, '--no-gen'], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(dir, '_shared.md'), 'utf8'), /pack content/);
    assert.match(sync.stdout, /受管栈 java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('账本损坏时 sync fail closed', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-gen'], root);
    assert.notEqual(sync.status, 0);
    assert.match(sync.stderr, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

测试中未使用的 `upstreamStack`、`existed` 变量应删除。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-integration.test.mjs`
Expected: FAIL，sync 覆盖受管文件或账本损坏不报错。

- [ ] **Step 3: 接入 sync**

```js
// scripts/hub-sync.mjs 顶部
// 注意：本文件第 44 行已有读取 .hub-sources.json 的本地 readSources，
// stack-ledger 的同名导出必须别名，否则会静默覆盖本地函数。
import { readSources as readStackSources, managedStackPrefixes } from './lib/stack-ledger.mjs';
```

在 `const sources = readSources(root);`（`.hub-sources.json`）之后增加：

```js
// 新账本损坏必须 fail closed：否则会当成“没有受管栈”继续覆盖。
const stackSources = readStackSources(root);
const managedPrefixes = managedStackPrefixes(stackSources);
const managedNames = new Set(Object.values(stackSources.packs).map((record) => record.installedAs));
const isManagedDest = (destRel) => managedPrefixes.some((prefix) => destRel.startsWith(prefix));
for (const name of managedNames) log('info', `受管栈 ${name}：由 stack pack 管理，sync 跳过`);
```

在 action 构建循环开头加入：

```js
if (isManagedDest(file.destRel)) continue;
```

`known` 与 `removed` 计算改为：

```js
// known 保留受管路径：否则模板库里真的提供同名文件时，会被误判为“模板已移除”。
const known = new Set(files.map((f) => f.hubRel));
const managedHubRels = [...managedNames].map((name) => `stacks/${name}/`);
const removed = Object.keys(sources?.files || {})
  .filter((rel) => rel.startsWith(HUB_PREFIX))
  .map((rel) => rel.slice(HUB_PREFIX.length))
  .filter((hubRel) => !known.has(hubRel) && !isGeneratedArtifact(hubRel))
  .filter((hubRel) => !managedHubRels.some((prefix) => hubRel.startsWith(prefix)));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-integration.test.mjs`
Expected: PASS，2 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/hub-sync.mjs tests/stack-integration.test.mjs
git commit -m "feat(sync): 跳过受管技术栈并校验账本"
```

---

### Task 13: `upstream` 与 `ship` 过滤受管栈

**Files:**
- Modify: `scripts/lib/upstream.mjs:138-193`
- Modify: `scripts/hub-upstream.mjs:215-290`
- Modify: `scripts/hub-ship.mjs:275-390`
- Test: `tests/stack-integration.test.mjs`

**Interfaces:**
- Consumes: `readSources`、`managedStackNames`。
- Produces: `resolveUnits(..., { managedStacks, allowManagedStacks, onManagedSkip })`；`--allow-fork` 放行。

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-integration.test.mjs 追加
test('upstream --all 与 ship --all 排除受管栈，显式 --stack 拒绝', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-upstream-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# pack content\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0', files: {},
        },
      },
    }));
    const all = run('hub-upstream.mjs', ['--root', root, '--all'], root);
    assert.equal(all.status, 0, all.stderr + all.stdout);
    assert.doesNotMatch(all.stdout, /java-spring 技术栈/);
    assert.match(all.stdout, /受管栈 java-spring/);

    const explicit = run('hub-upstream.mjs', ['--root', root, '--stack', 'java-spring'], root);
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /stack pack 管理/);

    const allowed = run('hub-upstream.mjs', ['--root', root, '--stack', 'java-spring', '--allow-fork'], root);
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-integration.test.mjs`
Expected: FAIL，upstream 仍回灌受管栈。

- [ ] **Step 3: 修改 resolveUnits 与调用点**

```js
// scripts/lib/upstream.mjs resolveUnits 签名与函数体
export function resolveUnits(root, {
  stage = null, stages = [], shared = false, stacks = [], all = false, onSkip = null,
  managedStacks = new Set(), allowManagedStacks = false, onManagedSkip = null,
} = {}) {
  const units = [];
  const seen = new Set();
  const managed = new Set(managedStacks);
  const blockedManaged = [];
  const add = (unit) => {
    const key = `${unit.kind}:${unit.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    units.push(unit);
  };
  const addStage = (name) => add({
    kind: 'stage',
    name,
    sourceRel: `.claude/hub/stages/${name}`,
    targetRel: `templates/stages/${name}`,
  });
  const addStack = (name) => {
    // 受管栈默认拒绝；显式 --allow-fork 才回灌，--all 也必须走同一条检查。
    if (managed.has(name) && !allowManagedStacks) {
      blockedManaged.push(name);
      return;
    }
    add({
      kind: 'stack',
      name,
      sourceRel: `.claude/hub/stacks/${name}`,
      targetRel: `templates/stacks/${name}`,
    });
  };
  for (const name of [...stages, ...(stage ? [stage] : [])]) addStage(name);
  for (const name of stacks) addStack(name);
  const sharedDir = join(root, '.claude', 'hub', '_shared');
  if (shared || (all && existsSync(sharedDir))) {
    add({
      kind: 'shared',
      name: 'shared',
      sourceRel: '.claude/hub/_shared',
      targetRel: 'templates/shared',
    });
  }
  if (all) {
    const dir = join(root, '.claude', 'hub', 'stages');
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) addStage(entry.name);
      }
    }
    const stacksDir = join(root, '.claude', 'hub', 'stacks');
    if (existsSync(stacksDir)) {
      const skipped = [];
      for (const entry of readdirSync(stacksDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        // 只回灌 hub.yaml 能引用的合法栈名，避免把无法声明的目录写进模板库。
        if (isValidStackName(entry.name)) addStack(entry.name);
        else skipped.push(entry.name);
      }
      if (skipped.length && onSkip) onSkip(skipped);
    }
  }
  if (blockedManaged.length && onManagedSkip) onManagedSkip([...new Set(blockedManaged)]);
  // 全部输入都被受管检查拦下时，不能退化成“参数缺失”的错误。
  if (!units.length && !blockedManaged.length) {
    throw new Error('必须指定 --stage <name>、--shared、--stack <name> 或 --all');
  }
  return units;
}
```

```js
// scripts/hub-upstream.mjs 顶部导入
import { readSources, managedStackNames } from './lib/stack-ledger.mjs';
```

在 `const stacks = argValues(argv, '--stack');` 之后、`const units = resolveUnits(...)` 之前插入：

```js
const managed = managedStackNames(readSources(root));
const allowManaged = hasFlag(argv, '--allow-fork');
for (const stack of stacks) {
  if (managed.has(stack) && !allowManaged) {
    throw new Error(`技术栈 ${stack} 由 stack pack 管理；确认回灌请加 --allow-fork`);
  }
}
```

随后把原有的 `const units = resolveUnits(root, { ... });` 替换为：

```js
const units = resolveUnits(root, {
  stage,
  shared,
  stacks,
  all,
  managedStacks: managed,
  allowManagedStacks: allowManaged,
  onManagedSkip: (names) => log('info', `受管栈 ${names.join('、')}：由 stack pack 管理，跳过回灌`),
  onSkip: (names) => log('warn', `跳过无法声明的技术栈目录：${names.join('、')}（只允许 [a-z0-9][a-z0-9_-]*）`),
});
```

`--allow-fork` 加入 `warnUnknownArgs` 的已知参数列表（`hub-upstream.mjs` 第 214 行那一组）。

```js
// scripts/hub-ship.mjs 顶部导入
import { readSources, managedStackNames } from './lib/stack-ledger.mjs';
```

在 `const stacks = argValues(argv, '--stack');` 之后、`const units = resume ? [] : resolveUnits(...)` 之前插入：

```js
const managed = managedStackNames(readSources(root));
const allowManaged = hasFlag(argv, '--allow-fork');
for (const stack of stacks) {
  if (managed.has(stack) && !allowManaged) {
    throw new Error(`技术栈 ${stack} 由 stack pack 管理；确认提交请加 --allow-fork`);
  }
}
```

随后把原有的 `resolveUnits` 调用替换为：

```js
const units = resume ? [] : resolveUnits(root, {
  stages,
  stacks,
  shared,
  all,
  managedStacks: managed,
  allowManagedStacks: allowManaged,
  onManagedSkip: (names) => log('info', `受管栈 ${names.join('、')}：由 stack pack 管理，跳过`),
  onSkip: (names) => log('warn', `跳过无法声明的技术栈目录：${names.join('、')}（只允许 [a-z0-9][a-z0-9_-]*）`),
});
```

`--allow-fork` 加入 ship 的已知参数列表（`hub-ship.mjs` 第 278 行那一组）。两个文件都没有本地 `readSources`，直接导入同名函数即可。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-integration.test.mjs`
Expected: PASS，3 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/upstream.mjs scripts/hub-upstream.mjs scripts/hub-ship.mjs tests/stack-integration.test.mjs
git commit -m "feat(upstream): 过滤 stack pack 管理的技术栈"
```

---

### Task 14: `doctor` 检查受管栈一致性

**Files:**
- Modify: `scripts/hub-doctor.mjs:262-380`
- Test: `tests/stack-integration.test.mjs`

**Interfaces:**
- Consumes: `readSources`、`readLock`、`stackPaths`、`contentHash`、`ensureRepo`、`refreshRef`、`resolveCommit`、`stackCacheRoot`。
- Produces: doctor 输出账本损坏、文件缺失/手改、lock 缺失、陈旧 owner 记录；`--check-remote` 联网报告落后 commit（默认不联网）。

- [ ] **Step 1: 追加失败测试**

先把 `tests/stack-integration.test.mjs` 顶部的 `run` 改成支持可选环境变量（其余调用不变）：

```js
function run(script, args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}
```

并在导入中加入 `spawnSync` 与 `contentHash`：

```js
import { spawnSync } from 'node:child_process';
import { contentHash } from '../scripts/lib/common.mjs';
```

```js
// tests/stack-integration.test.mjs 追加
test('doctor 报告受管栈缺失文件与陈旧 hub-sources 记录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0',
          files: {
            '.claude/hub/stacks/java-spring/_shared.md': { base: 'x', local: 'x' },
            '.claude/hub/stacks/java-spring/plan.md': { base: 'y', local: 'y' },
          },
        },
      },
    }));
    writeFileSync(join(dir, '_shared.md'), '# local edit\n');
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: { '.claude/hub/stacks/java-spring/_shared.md': { base: 'z', local: 'z' } },
    }));
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /plan\.md.*缺失|缺失.*plan\.md/);
    assert.match(res.stdout, /陈旧/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在账本损坏时报错', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor --check-remote 报告落后 commit，默认不联网', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-remote-'));
  try {
    const root = makeProject(base);
    const repo = join(base, 'remote');
    mkdirSync(repo, { recursive: true });
    const g = (args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr + res.stdout);
    };
    g(['init', '-b', 'main']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    const writePack = (text) => {
      const packDir = join(repo, 'stacks', 'java-spring');
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, '_shared.md'), text);
      writeFileSync(join(packDir, 'stack.json'), JSON.stringify({
        name: 'java-spring', version: '1.2.0', minDevflow: '>=1.7.0',
        detects: ['java-maven'], files: { '_shared.md': contentHash(text) },
      }));
      writeFileSync(join(repo, 'index.json'), JSON.stringify({
        schemaVersion: 1,
        packs: { 'java-spring': { path: 'stacks/java-spring', detects: ['java-maven'] } },
      }));
      g(['add', '.']);
      g(['commit', '-m', 'pack']);
    };
    writePack('# shared v1\n');
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', [
      'add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen',
    ], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);

    // 默认 doctor 不碰网络：给一个全新缓存目录，运行后应仍不存在。
    const quietCache = join(base, 'quiet-cache');
    const quiet = run('hub-doctor.mjs', ['--root', root], root, {
      DEVFLOW_CACHE_DIR: quietCache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1',
    });
    assert.equal(quiet.status, 0, quiet.stderr + quiet.stdout);
    assert.doesNotMatch(quiet.stdout, /落后/);
    assert.equal(existsSync(quietCache), false);

    writePack('# shared v2\n');
    const checked = run('hub-doctor.mjs', ['--root', root, '--check-remote'], root, env);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.match(checked.stdout, /落后/);
    assert.match(checked.stdout, /stack update/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-integration.test.mjs`
Expected: FAIL，doctor 不检查新增文件。

- [ ] **Step 3: 实现 doctor 检查**

```js
// scripts/hub-doctor.mjs 顶部，追加到已有的 lib 导入之后
import { readSources, readLock, stackPaths } from './lib/stack-ledger.mjs';
import {
  ensureRepo, refreshRef, resolveCommit, stackCacheRoot,
} from './lib/stack-fetch.mjs';
```

`main` 开头的参数处理改成：

```js
  warnUnknownArgs(argv, ['--root', '--json', '--mode', '--check-remote']);
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  // 设计第 15 节：只有显式 --check-remote 才联网，默认体检不访问网络。
  const checkRemote = hasFlag(argv, '--check-remote');
```

插入位置：`if (config) { ... }` 块结束之后、`const eco = loadEcosystem(root);` 之前（当前第 394-396 行之间）。`hub-doctor.mjs` 已导入 `existsSync`、`join`、`readText`、`contentHash`，不需要重复导入。

```js
  const stackState = stackPaths(root);
  const staleHubSources = join(root, '.claude', '.hub-sources.json');
  const staleHubBases = join(root, '.claude', '.hub-bases', 'stacks');
  try {
    const sources = readSources(root);
    const lock = readLock(root);
    const entries = Object.values(sources.packs);
    if (!entries.length) {
      add('ok', '没有受管的技术栈包');
    } else {
      for (const record of entries) {
        const dir = stackState.stackDir(record.installedAs);
        if (!existsSync(dir)) {
          add('error', `受管栈目录缺失：.claude/hub/stacks/${record.installedAs}`, '运行 devflow stack restore');
          continue;
        }
        const missing = [];
        const modified = [];
        for (const [rel, hashes] of Object.entries(record.files || {})) {
          const abs = join(root, ...rel.split('/'));
          // local === null 表示上次更新时本地已删除；这是账本事实，不能只看文件是否存在。
          if (hashes.local === null || !existsSync(abs)) {
            missing.push(rel);
            continue;
          }
          // 手改只报告，不阻断；缺失才给恢复建议。
          if (contentHash(readText(abs)) !== hashes.local) modified.push(rel);
        }
        if (missing.length) {
          add('warn', `受管栈 ${record.installedAs} 缺失 ${missing.length} 个文件：${missing.join('、')}`, '运行 devflow stack restore');
        }
        if (modified.length) {
          add('info', `受管栈 ${record.installedAs} 有 ${modified.length} 个文件被手改（保留，不阻断）`);
        }
        if (!lock.packs[record.installedAs]) {
          add('warn', `受管栈 ${record.installedAs} 未写入 stack-lock.yaml`, '运行 devflow stack lock');
        }
        if (existsSync(staleHubSources)) {
          try {
            const data = JSON.parse(readText(staleHubSources));
            const prefix = `.claude/hub/stacks/${record.installedAs}/`;
            if (Object.keys(data.files || {}).some((rel) => rel.startsWith(prefix))) {
              add('warn', `受管栈 ${record.installedAs} 仍有陈旧的 .hub-sources.json 记录`, '运行 devflow sync 或手工删除该记录');
            }
          } catch { /* 由现有 hub-sources 检查处理 */ }
        }
        if (existsSync(join(staleHubBases, record.installedAs))) {
          add('warn', `受管栈 ${record.installedAs} 仍有陈旧的 .hub-bases 快照`, '删除该目录；pack 使用 .stack-bases');
        }
        if (checkRemote && record.source === 'git' && record.repo) {
          try {
            const info = ensureRepo({
              url: record.repo,
              cacheRoot: stackCacheRoot(),
              allowFile: process.env.DEVFLOW_STACK_ALLOW_LOCAL_REPO === '1',
            });
            const ref = record.ref || 'main';
            refreshRef({ repoGit: info.repoGit, ref });
            const latest = resolveCommit({ repoGit: info.repoGit, ref });
            if (record.commit && latest !== record.commit) {
              add(
                'warn',
                `受管栈 ${record.installedAs} 落后于 ${ref}（本地 ${record.commit.slice(0, 8)}，远程 ${latest.slice(0, 8)}）`,
                '运行 devflow stack update',
              );
            }
          } catch (err) {
            // 网络或证书问题不应让 doctor 失败；只说明本次无法检查。
            add('warn', `无法检查 ${record.installedAs} 的远程状态：${err.message}`);
          }
        }
        if (!missing.length && !modified.length) {
          add('ok', `受管栈 ${record.installedAs}@${record.version} 完整`);
        }
      }
      // 设计第 15 节：lock 与本地账本也要比对，不能只在 lock 缺失时提示。
      for (const [name, entry] of Object.entries(lock.packs)) {
        const record = sources.packs[name];
        if (!record) {
          add('warn', `stack-lock.yaml 记录了未安装的包 ${name}`, '运行 devflow stack restore，或手工删除该条目');
          continue;
        }
        if (record.packId !== entry.packId || record.repo !== entry.repo) {
          add('warn', `受管栈 ${name} 的来源与 stack-lock.yaml 不一致`, '运行 devflow stack lock 重建');
        } else if (record.commit && entry.commit && record.commit !== entry.commit) {
          add('warn', `受管栈 ${name} 的 commit 与 stack-lock.yaml 不一致`, '运行 devflow stack lock 重建');
        }
      }
    }
  } catch (err) {
    // 账本或 lock 损坏必须让 doctor 失败，不能降级成“没有受管栈”。
    add('error', err.message, '修复或删除 .claude/.stack-sources.json / stack-lock.yaml 后重试');
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-integration.test.mjs`
Expected: PASS，6 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/hub-doctor.mjs tests/stack-integration.test.mjs
git commit -m "feat(doctor): 检查受管技术栈一致性并支持 --check-remote"
```

---

### Task 15: `init` 的 `.gitignore` 与 Java/Vue 提示

**Files:**
- Modify: `scripts/hub-init.mjs:124-134, 294-309`
- Modify: `scripts/lib/discover.mjs`
- Test: `tests/stack-integration.test.mjs`

**Interfaces:**
- Consumes: `detectPackHints`。
- Produces: `detectFrameworks(dir): string[]`、`detectPackHints(root, subs): string[]`；init 输出安装提示。

- [ ] **Step 1: 追加失败测试**

```js
// tests/stack-integration.test.mjs 追加
test('init 写入 stack 忽略项并提示 Java 包', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-init-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pom.xml'), '<project></project>');
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const line of ['.claude/.stack-sources.json', '.claude/.stack-bases/', '.claude/.stack-staging/', '.claude/.stack-trash/']) {
      assert.match(ignore, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(init.stdout, /devflow stack add java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Vue 3 项目提示 vue3 包', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-vue-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'web', dependencies: { vue: '^3.5.0' }, scripts: { test: 'node --test' },
    }));
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.match(init.stdout, /devflow stack add vue3/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-integration.test.mjs`
Expected: FAIL，缺少忽略项与提示。

- [ ] **Step 3: 实现探测与提示**

```js
// scripts/lib/discover.mjs 追加（已导入 existsSync、join、readText）
export function detectFrameworks(dir) {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return [];
  try {
    const data = JSON.parse(readText(pkg));
    const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) };
    // 只认 Vue 3：Vue 2 的规范差异大，误报会诱导安装错误的包。
    // 兼容 ^3.5.0、~3.4、>=3.0、3.x、npm:vue@3.5.0 等写法。
    const vue = deps.vue;
    if (typeof vue === 'string' && /(^|[^0-9])3\./.test(vue)) return ['vue3'];
    return [];
  } catch {
    return [];
  }
}

export function detectPackHints(root, subs = []) {
  const dirs = [root, ...subs.map((sub) => join(root, ...String(sub?.path || sub?.name || '.').split('/')))];
  const hints = [];
  for (const dir of dirs) {
    if (existsSync(join(dir, 'pom.xml')) || existsSync(join(dir, 'build.gradle'))) {
      if (!hints.includes('java-spring')) hints.push('java-spring');
    }
    if (detectFrameworks(dir).includes('vue3') && !hints.includes('vue3')) hints.push('vue3');
  }
  return hints;
}
```

```js
// scripts/hub-init.mjs 顶部：并入已有的 discover.mjs 导入行，避免重复 import
import { discoverSubprojects, detectTestCommand, detectPackHints } from './lib/discover.mjs';
```

```js
// scripts/hub-init.mjs GITIGNORE_BLOCK，追加在 .hub-bases/ 之后
.claude/.stack-sources.json
.claude/.stack-bases/
.claude/.stack-staging/
.claude/.stack-trash/
```

在 `main` 函数作用域声明提示容器（放在 `const previousMeta = readMeta(root) || {};` 附近）：

```js
  // 只在首次初始化时探测：已初始化的项目不再反复提示安装。
  let packHints = [];
```

在 else 分支的 `const { list: subs, expanded } = discoverSubprojects(root);` 之后加入：

```js
    packHints = detectPackHints(root, subs);
```

在函数末尾的 next steps 中追加（当前第 379-386 行）：

```js
  const nextSteps = ['直接开始：/devflow:req <需求>'];
  if (!noDraft) {
    nextSteps.push('（可选）填写 .claude/hub/_shared/project-basics.md 中的 TODO，并删除已填草稿首行的草稿标记');
    nextSteps.push('（可选）技术栈草稿在 .claude/hub/stacks/<stack>/；多栈或不确定放哪时用 devflow-rule-placement');
  }
  const repoHint = process.env.DEVFLOW_STACK_REPO
    ? ` --repo ${process.env.DEVFLOW_STACK_REPO}`
    : ' --repo <仓库地址>';
  for (const hint of packHints) {
    nextSteps.push(`（可选）检测到 ${hint} 技术栈：devflow stack add ${hint}${repoHint}`);
  }
  nextSteps.push('（可选）node scripts/devflow-gen.mjs 刷新投影，node scripts/devflow-doctor.mjs 体检');
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-integration.test.mjs`
Expected: PASS，8 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add scripts/hub-init.mjs scripts/lib/discover.mjs tests/stack-integration.test.mjs
git commit -m "feat(init): 增加 stack 忽略项与技术栈安装提示"
```

---

### Task 16: 技能入口、帮助与文档

**Files:**
- Create: `skills/stack/SKILL.md`
- Modify: `bin/devflow`
- Modify: `docs/usage.md`
- Modify: `README.md`
- Test: `tests/stack-cli.test.mjs`

**Interfaces:**
- Consumes: CLI 子命令与 `docs/stack-packs-design.md`。
- Produces: 显式 `devflow:stack` 技能与用户可见命令说明。

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-cli.test.mjs 追加
test('stack 技能存在且禁止模型自动调用', () => {
  const file = join(PLUGIN_ROOT, 'skills', 'stack', 'SKILL.md');
  assert.equal(existsSync(file), true);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---[\s\S]*name: stack[\s\S]*---/);
  assert.match(text, /disable-model-invocation:\s*true/);
});

test('CLI 帮助与 usage 文档包含 stack 命令', () => {
  const help = spawnSync(NODE, [join(PLUGIN_ROOT, 'bin', 'devflow'), 'help'], { encoding: 'utf8' });
  assert.match(help.stdout, /stack/);
  const usage = readFileSync(join(PLUGIN_ROOT, 'docs', 'usage.md'), 'utf8');
  assert.match(usage, /devflow stack add/);
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\/devflow:stack/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-cli.test.mjs`
Expected: FAIL，技能与文档缺失。

- [ ] **Step 3: 写技能与文档**

````md
---
name: stack
description: 按需安装、更新、恢复或删除技术栈包（stack packs）
argument-hint: <add|list|update|restore|remove|status|lock|lint|cache> [...]
allowed-tools: Bash(node:*), Read, Glob, Grep
disable-model-invocation: true
---

对当前项目运行技术栈包命令。

优先使用项目内 loader：

```bash
node scripts/devflow-stack.mjs $ARGUMENTS
```

不存在时直接调用插件脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-stack.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

规则：

1. `add` 必须显式提供 `--repo <url>`、`--from <dir>` 或环境变量 `DEVFLOW_STACK_REPO`；不要猜测默认源。
2. 安装成功后，提醒用户把 `stack: <installedAs>` 写入 `.claude/hub/hub.yaml` 的顶层或对应 `subprojects`，再运行 `gen`。
3. `status`、`list`、`lint` 只读；`remove`、`restore --force`、`update --force` 属于破坏性操作，执行前必须向用户确认。
4. 不修改 pack 缓存中的快照，也不手工编辑 `.claude/.stack-sources.json`。
````

在 `bin/devflow` 的 HELP 示例中加入：

```text
  devflow stack add java-spring --repo <url>
  devflow stack list
  devflow stack update --all
  devflow stack restore
  devflow stack status --json
  devflow stack remove java-spring --keep
```

在 `docs/usage.md` 增加一节：

````md
## 技术栈包（stack packs）

技术栈包从独立仓库按需安装单个栈，不会 clone 整个仓库，也不会随插件全量内置。

```bash
devflow stack add java-spring --repo <url> [--ref main]
devflow stack add java-spring --from ../devflow-stacks
devflow stack list
devflow stack update java-spring
devflow stack restore
devflow stack status
devflow stack remove java-spring --keep
```

来源与 commit 写入 `.claude/hub/stack-lock.yaml`；本机安装事实写入 `.claude/.stack-sources.json`（已在 `.gitignore` 中）。设计细节见 [stack-packs-design.md](stack-packs-design.md)。
````

在 `README.md` 的命令概览表格末尾（`sync` 那一行之后）增加：

```md
| `/devflow:stack <add|list|update|restore|remove|status|lock|lint|cache> [...]` | 按需安装、更新、恢复或删除技术栈包；`add` 必须提供 `--repo`、`--from` 或 `DEVFLOW_STACK_REPO`，安装后需在 `hub.yaml` 声明 `stack` |
```

在 README 的命令示例块（`devflow sync --dry-run` 附近）增加一行：

```bash
devflow stack add java-spring --repo <url>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/stack-cli.test.mjs tests/docs.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/stack/SKILL.md bin/devflow docs/usage.md README.md tests/stack-cli.test.mjs
git commit -m "docs(stack): 增加技能入口与使用说明"
```

---

### Task 17: 静态 fixture、发布检查与全量测试

**Files:**
- Create: `tests/fixtures/stack-pack/index.json`
- Create: `tests/fixtures/stack-pack/stacks/java-spring/stack.json`
- Create: `tests/fixtures/stack-pack/stacks/java-spring/_shared.md`
- Create: `tests/fixtures/stack-pack/stacks/java-spring/plan.md`
- Test: `tests/stack-cli.test.mjs`

**Interfaces:**
- Consumes: `devflow stack lint`。
- Produces: 可提交的官方仓库样例，供文档与 lint 测试使用。

- [ ] **Step 1: 写失败测试**

```js
// tests/stack-cli.test.mjs 追加
test('静态 fixture 可通过 stack lint', () => {
  const fixture = join(PLUGIN_ROOT, 'tests', 'fixtures', 'stack-pack');
  const res = run('hub-stack.mjs', ['lint', fixture], PLUGIN_ROOT);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /java-spring@1\.0\.0/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/stack-cli.test.mjs`
Expected: FAIL，fixture 不存在。

- [ ] **Step 3: 创建 fixture**

下面每个代码块只包含文件内容；文件路径写在块外，不要把路径标注写进 JSON 或 Markdown，否则 `contentHash` 会对不上。

文件：`tests/fixtures/stack-pack/index.json`

```json
{
  "schemaVersion": 1,
  "packs": {
    "java-spring": {
      "title": "Spring Boot / Maven",
      "description": "Java 后端阶段规范样例",
      "path": "stacks/java-spring",
      "detects": ["java-maven", "java-gradle"],
      "tags": ["java", "spring", "backend"]
    }
  }
}
```

文件：`tests/fixtures/stack-pack/stacks/java-spring/stack.json`

```json
{
  "name": "java-spring",
  "title": "Spring Boot / Maven",
  "version": "1.0.0",
  "minDevflow": ">=1.7.0",
  "detects": ["java-maven", "java-gradle"],
  "files": {
    "_shared.md": "75a28267c147da483ea87bb878891a7fad807859f0c126bde5a018f1d9542f21",
    "plan.md": "617f2842ddd22bb936c47cb82d38a592929d8e2f9bb8d729f1a0b8a102724761"
  }
}
```

上面两个哈希对应下方正文的 `contentHash`（LF 归一化、含末尾换行）。如果修改了 fixture 正文，必须重新计算，否则 `stack lint` 会拒绝该 fixture：

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { contentHash } from './scripts/lib/common.mjs';
const dir = 'tests/fixtures/stack-pack/stacks/java-spring';
const file = dir + '/stack.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
data.files = {
  '_shared.md': contentHash(readFileSync(dir + '/_shared.md', 'utf8')),
  'plan.md': contentHash(readFileSync(dir + '/plan.md', 'utf8')),
};
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
"
```

`_shared.md` 与 `plan.md`：

文件：`tests/fixtures/stack-pack/stacks/java-spring/_shared.md`

```md
# Java / Spring 通用规则

- 使用构造器注入，避免字段注入。
- 公共异常统一映射，不把堆栈返回给客户端。
```

文件：`tests/fixtures/stack-pack/stacks/java-spring/plan.md`

```md
# Java / Spring 方案规范

- 方案中列出接口、事务边界与回滚策略。
- 新增依赖说明用途与替代方案。
```

- [ ] **Step 4: 运行全量测试**

Run: `npm test`
Expected: 所有现有测试与新增测试通过，不写死数量。

- [ ] **Step 5: 运行插件自检**

Run: `node scripts/hub-doctor.mjs --mode plugin`
Expected: 无 error；`COMMANDS` 与脚本齐全。

- [ ] **Step 6: 提交**

```bash
git add tests/fixtures/stack-pack tests/stack-cli.test.mjs
git commit -m "test(stack): 增加官方仓库 fixture 与 lint 检查"
```

---

## 自查清单

- [ ] 设计文档第 8 节第 4 步的两次移动都在回滚区间内：Task 5 的 `movedTarget`/`movedBases` 与 `rollback()` 已覆盖“移动 target 成功、移动 bases 失败”。
- [ ] 账本损坏时 `sync`、`upstream`、`ship`、`doctor`、`stack` 都 fail closed：Task 3 与 Task 12-14。
- [ ] `--force` 只覆盖目录：Task 5 与 Task 11 没有绕过任何校验。
- [ ] 安装不写 `hub.yaml`：所有任务只读 `hub.yaml`；安装成功提示由 Task 16 的技能规则承担。
- [ ] `--from` 只写本地账本、不写 lock：Task 5 的 `commitStagedTree` 对 `source.type === 'local'` 删除 lock 条目。
- [ ] 快照不可变且包外有 meta：Task 8。
- [ ] 缓存与账本使用 failClosed 锁：Task 3 与 Task 8。
- [ ] 受管栈在 actions、known、manifest 三处处理：Task 12；owner 转移在 Task 5。
- [ ] 官方仓库样例可 lint：Task 17。
