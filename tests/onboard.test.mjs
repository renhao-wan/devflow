import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUTO_START, AUTO_END, OVERVIEW_FILE, scanFacts, generateOverview, upsertAutoBlock,
} from '../scripts/lib/overview.mjs';
import { main as onboardMain } from '../scripts/hub-onboard.mjs';
import { main as initMain } from '../scripts/hub-init.mjs';

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-onboard-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  writeFileSync(join(root, 'go.mod'), 'module demo\n');
  writeFileSync(join(root, 'README.md'), '# Demo\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.js'), 'console.log(1)\n');
  mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'stages:',
    '  - req',
    'subprojects: {}',
    'defaults:',
    '  testCommand: "npm test"',
    '',
  ].join('\n'));
  return root;
}

test('scanFacts 识别构建文件、顶层目录与入口', () => {
  const root = makeProject();
  const facts = scanFacts(root, { full: true });
  assert.ok(facts.techStack.some((t) => /Node\.js/.test(t)));
  assert.ok(facts.techStack.some((t) => /Go/.test(t)));
  assert.ok(facts.topDirs.includes('src'));
  assert.ok(facts.entrypoints.includes('src/index.js'));
  rmSync(root, { recursive: true, force: true });
});

test('scanFacts 不把只含 devflow loader 的 scripts/ 当作项目结构', () => {
  const root = makeProject();
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'devflow-gen.mjs'), '// loader\n');
  writeFileSync(join(root, 'scripts', 'devflow-doctor.mjs'), '// loader\n');
  try {
    assert.ok(!scanFacts(root).topDirs.includes('scripts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanFacts 保留含真实源码的 scripts/', () => {
  const root = makeProject();
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'devflow-gen.mjs'), '// loader\n');
  writeFileSync(join(root, 'scripts', 'release.mjs'), '// 项目自己的脚本\n');
  try {
    assert.ok(scanFacts(root).topDirs.includes('scripts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('技术栈包含子项目构建文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-onboard-sub-'));
  mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
  mkdirSync(join(root, 'services', 'api'), { recursive: true });
  writeFileSync(join(root, 'services', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'stages:',
    '  - req',
    'subprojects:',
    '  api:',
    '    path: services/api',
    'defaults:',
    '  testCommand: null',
    '',
  ].join('\n'));
  const result = generateOverview(root, { now: 'fixed' });
  assert.ok(result.facts.techStack.some((t) => /Node\.js/.test(t) && /services\/api\/package\.json/.test(t)));
  rmSync(root, { recursive: true, force: true });
});

test('入口只接受文件，不把目录当作入口', () => {
  const root = makeProject();
  mkdirSync(join(root, 'src', 'main', 'java'), { recursive: true });
  const facts = scanFacts(root, { full: true });
  assert.ok(facts.entrypoints.includes('src/index.js'));
  assert.ok(!facts.entrypoints.includes('src/main/java'));
  rmSync(root, { recursive: true, force: true });
});

test('入口扫描覆盖子项目', () => {
  const root = makeProject();
  mkdirSync(join(root, 'services', 'api', 'src'), { recursive: true });
  writeFileSync(join(root, 'services', 'api', 'src', 'index.js'), '');
  const facts = scanFacts(root, { subprojectPaths: ['services/api'] });
  assert.ok(facts.entrypoints.includes('src/index.js'));
  assert.ok(facts.entrypoints.includes('services/api/src/index.js'));
  rmSync(root, { recursive: true, force: true });
});

test('入口扫描识别 Java 与 Go 入口', () => {
  const root = makeProject();
  mkdirSync(join(root, 'src', 'main', 'java', 'com', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src', 'main', 'java', 'com', 'demo', 'DemoApplication.java'), '');
  writeFileSync(join(root, 'src', 'main', 'java', 'com', 'demo', 'Helper.java'), '');
  mkdirSync(join(root, 'cmd', 'server'), { recursive: true });
  writeFileSync(join(root, 'cmd', 'server', 'main.go'), '');
  const facts = scanFacts(root);
  assert.ok(facts.entrypoints.includes('src/main/java/com/demo/DemoApplication.java'));
  assert.ok(!facts.entrypoints.includes('src/main/java/com/demo/Helper.java'));
  assert.ok(facts.entrypoints.includes('cmd/server/main.go'));
  rmSync(root, { recursive: true, force: true });
});

test('重复扫描根不会产生重复入口', () => {
  const root = makeProject();
  const facts = scanFacts(root, { subprojectPaths: ['src', 'src'] });
  assert.equal(facts.entrypoints.filter((p) => p === 'src/index.js').length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('generateOverview 写入标记块与事实', () => {
  const root = makeProject();
  const result = generateOverview(root, { full: true, now: '2026-11-02T00:00:00.000Z' });
  assert.equal(result.file, join(root, OVERVIEW_FILE));
  const text = readFileSync(result.file, 'utf8');
  assert.ok(text.includes(AUTO_START));
  assert.ok(text.includes(AUTO_END));
  assert.match(text, /npm test/);
  assert.match(text, /Node\.js/);
  rmSync(root, { recursive: true, force: true });
});

test('重扫只更新自动段，保留人工补充', () => {
  const root = makeProject();
  generateOverview(root, { full: true, now: '2026-11-02T00:00:00.000Z' });
  const file = join(root, OVERVIEW_FILE);
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n人工笔记：领域术语\n`);
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'stages:',
    '  - req',
    'subprojects: {}',
    'defaults:',
    '  testCommand: "npm run test:changed"',
    '',
  ].join('\n'));
  generateOverview(root, { full: true, now: '2026-11-03T00:00:00.000Z' });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /人工笔记：领域术语/);
  assert.match(text, /npm run test:changed/);
  assert.match(text, /2026-11-03/);
  assert.doesNotMatch(text, /2026-11-02/);
  rmSync(root, { recursive: true, force: true });
});

test('内容未变时不重写文件，也不更新时间戳', () => {
  const root = makeProject();
  const first = generateOverview(root);
  const before = readFileSync(first.file, 'utf8');
  const second = generateOverview(root);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(second.file, 'utf8'), before);
  assert.equal(second.content, before);
  rmSync(root, { recursive: true, force: true });
});

test('相同输入幂等', () => {
  const root = makeProject();
  const a = generateOverview(root, { full: true, now: 'fixed' });
  const b = generateOverview(root, { full: true, now: 'fixed' });
  assert.equal(a.content, b.content);
  assert.equal(b.changed, false);
  rmSync(root, { recursive: true, force: true });
});

test('upsertAutoBlock 保留标记外内容', () => {
  const current = `${AUTO_START}\n旧\n${AUTO_END}\n\n## 项目补充\n\n手工内容\n`;
  const next = upsertAutoBlock(current, `${AUTO_START}\n新\n${AUTO_END}`);
  assert.match(next, /新/);
  assert.doesNotMatch(next, /旧/);
  assert.match(next, /手工内容/);
});

test('残缺标记块不会产生重复标记', () => {
  const root = makeProject();
  const file = join(root, OVERVIEW_FILE);
  writeFileSync(file, `${AUTO_START}\n旧自动内容\n\n人工笔记：保留我\n`);
  generateOverview(root, { now: 'fixed' });
  const text = readFileSync(file, 'utf8');
  assert.equal((text.match(/devflow:auto:start/g) || []).length, 1);
  assert.equal((text.match(/devflow:auto:end/g) || []).length, 1);
  assert.match(text, /人工笔记：保留我/);
  rmSync(root, { recursive: true, force: true });
});

test('--print 输出内容且不写文件', () => {
  const root = makeProject();
  const result = onboardMain(['--root', root, '--print', '--now', 'fixed']);
  assert.match(result.content, /Node\.js/);
  assert.equal(existsSync(join(root, OVERVIEW_FILE)), false);
  rmSync(root, { recursive: true, force: true });
});

test('默认输出包含概览摘要', () => {
  const root = makeProject();
  const r = spawnSync(process.execPath, [
    resolve(import.meta.dirname, '..', 'scripts', 'hub-onboard.mjs'),
    '--root', root,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /项技术栈/);
  assert.match(r.stdout, /个入口/);
  assert.match(r.stdout, /个 CI/);
  rmSync(root, { recursive: true, force: true });
});

test('--print 与 --json 互斥', () => {
  const root = makeProject();
  assert.throws(() => onboardMain(['--root', root, '--print', '--json']), /不能同时使用/);
  rmSync(root, { recursive: true, force: true });
});

test('--root 不存在时报错', () => {
  const root = makeProject();
  assert.throws(() => onboardMain(['--root', join(root, 'missing')]), /不存在|不是目录/);
  rmSync(root, { recursive: true, force: true });
});

test('读取 CRLF 文件时统一行尾', () => {
  const root = makeProject();
  const file = join(root, OVERVIEW_FILE);
  writeFileSync(file, '## 项目补充\r\n\r\n人工笔记\r\n');
  generateOverview(root, { now: 'fixed' });
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /\r/);
  assert.match(text, /人工笔记/);
  rmSync(root, { recursive: true, force: true });
});

test('测试命令含反引号时安全渲染', () => {
  const root = makeProject();
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'stages:',
    '  - req',
    'subprojects: {}',
    'defaults:',
    '  testCommand: "echo `x`"',
    '',
  ].join('\n'));
  const result = generateOverview(root, { now: 'fixed' });
  assert.ok(result.content.includes('`` echo `x` ``'), result.content);
  rmSync(root, { recursive: true, force: true });
});

test('概览写入事实指纹，时间戳变化不重写', () => {
  const root = makeProject();
  const first = generateOverview(root, { now: '2026-01-01T00:00:00.000Z' });
  assert.match(first.content, /<!-- devflow:facts:[a-f0-9]{64} -->/);
  const second = generateOverview(root, { now: '2026-01-02T00:00:00.000Z' });
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.changed, false);
  rmSync(root, { recursive: true, force: true });
});

test('已初始化但缺少概览时 init 会补生成', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-init-overview-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  await initMain(['--root', root]);
  rmSync(join(root, OVERVIEW_FILE));
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await initMain(['--root', root]);
  } finally {
    console.log = original;
  }
  assert.equal(existsSync(join(root, OVERVIEW_FILE)), true);
  assert.ok(logs.some((l) => /补生成项目概览/.test(l)), logs.join('\n'));
  rmSync(root, { recursive: true, force: true });
});

test('init 生成简版项目概览', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-init-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  await initMain(['--root', root]);
  const file = join(root, OVERVIEW_FILE);
  assert.equal(existsSync(file), true);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(AUTO_START));
  assert.doesNotMatch(text, /### 关键入口/);
  rmSync(root, { recursive: true, force: true });
});

test('init 先报告创建工作区再报告生成概览', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-init-order-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await initMain(['--root', root]);
  } finally {
    console.log = original;
  }
  const created = logs.findIndex((l) => l.includes('创建') && l.includes('hub.yaml'));
  const overview = logs.findIndex((l) => l.includes('生成项目概览'));
  assert.ok(created !== -1, logs.join('\n'));
  assert.ok(overview !== -1, logs.join('\n'));
  assert.ok(created < overview, logs.join('\n'));
  rmSync(root, { recursive: true, force: true });
});

test('拒绝通过 junction 写到项目外', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证 junction');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'devflow-onboard-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'devflow-onboard-outside-'));
  let junction = null;
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(outside, 'hub.yaml'), 'version: 1\nstages:\n  - req\nsubprojects: {}\ndefaults:\n  testCommand: null\n');
    junction = join(root, '.claude', 'hub');
    const link = spawnSync('cmd', ['/c', 'mklink', '/J', junction, outside], { encoding: 'utf8' });
    if (link.status !== 0) {
      t.skip('mklink /J 不可用');
      return;
    }
    assert.throws(() => generateOverview(root, { now: 'fixed' }), /越界/);
    assert.equal(existsSync(join(outside, 'project-overview.md')), false);
  } finally {
    if (junction) spawnSync('cmd', ['/c', 'rmdir', junction], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
