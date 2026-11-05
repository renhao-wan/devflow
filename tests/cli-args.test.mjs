import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unknownArgs, warnUnknownArgs } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-cli-args-'));
  mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'stages:\n  - req\n');
  mkdirSync(join(root, 'docs', 'devflow'), { recursive: true });
  return root;
}

test('unknownArgs 只报告未声明的长参数', () => {
  assert.deepEqual(
    unknownArgs(['--root', '.', '--typo', '--typo=1', '--other=2', '-h', '--'], ['--root']),
    ['--typo', '--other'],
  );
});

test('warnUnknownArgs 逐个输出警告并返回参数名', () => {
  let text = '';
  const unknown = warnUnknownArgs(['--known', '--typo', '--other=1'], ['--known'], {
    stream: { write: (chunk) => { text += chunk; } },
  });
  assert.deepEqual(unknown, ['--typo', '--other']);
  assert.match(text, /\[WARN\] 未知参数：--typo（已忽略）/);
  assert.match(text, /\[WARN\] 未知参数：--other（已忽略）/);
});

test('脚本对未知参数给出统一 warning，JSON 输出仍可解析', () => {
  const root = makeRoot();
  try {
    const result = run(
      'hub-route.mjs',
      ['--root', root, '--json', '--stage', 'req', '--force-devflow', '--typo'],
      root,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /\[WARN\] 未知参数：--typo（已忽略）/);
    // JSON 模式下的日志标签与普通输出一致，统一大写。
    assert.doesNotMatch(result.stderr, /\[warn\]/);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 接入 warnUnknownArgs 的脚本；mark-test 走严格拒绝，白名单在 KNOWN_FLAGS 中维护。
const SCRIPT_FILES = [
  'gen-claude-skills.mjs', 'hub-doctor.mjs', 'hub-init.mjs', 'hub-onboard.mjs',
  'hub-route.mjs', 'hub-ship.mjs', 'hub-status.mjs', 'hub-sync.mjs',
  'hub-upstream.mjs', 'review-triage.mjs', 'stage-check.mjs', 'statusline.mjs',
  'trace.mjs',
];

test('未知参数白名单覆盖脚本实际读取的长参数', () => {
  for (const script of SCRIPT_FILES) {
    const source = readFileSync(join(PLUGIN_ROOT, 'scripts', script), 'utf8');
    const block = /warnUnknownArgs\(argv, \[([\s\S]*?)\]\)/.exec(source);
    assert.ok(block, `${script} 未接入 warnUnknownArgs`);
    const declared = new Set([...block[1].matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]));
    const used = new Set();
    for (const m of source.matchAll(/(?:argValue|argValues|hasFlag|hasOption)\(argv, '(--[a-z0-9-]+)'/g)) {
      used.add(m[1]);
    }
    for (const m of source.matchAll(/arg\s*(?:===|\.startsWith\()\s*'(--[a-z0-9-]+)/g)) {
      used.add(m[1]);
    }
    for (const name of used) {
      assert.ok(declared.has(name), `${script} 的白名单缺少 ${name}`);
    }
  }
});

test('hub-status 控制台的缺口列表超长时截断', () => {
  const root = makeRoot();
  try {
    const dir = join(root, 'docs', 'devflow', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'req.md'), `# 需求

## 验收标准

- [ ] AC-1 甲
- [ ] AC-2 乙
- [ ] AC-3 丙
- [ ] AC-4 丁
`);
    const result = run('hub-status.mjs', ['--root', root], root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /验收跟踪：0\/4 已覆盖，缺口 AC-1、AC-2、AC-3 等/);
    assert.doesNotMatch(result.stdout, /缺口 AC-1、AC-2、AC-3、AC-4/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
