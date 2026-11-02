import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  generateOverview(root, { full: true, now: '2026-11-03T00:00:00.000Z' });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /人工笔记：领域术语/);
  assert.match(text, /2026-11-03/);
  assert.doesNotMatch(text, /2026-11-02/);
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

test('--print 输出内容且不写文件', () => {
  const root = makeProject();
  const result = onboardMain(['--root', root, '--print', '--now', 'fixed']);
  assert.match(result.content, /Node\.js/);
  assert.equal(existsSync(join(root, OVERVIEW_FILE)), false);
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
