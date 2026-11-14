import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMANDS } from '../scripts/lib/cli-commands.mjs';
import { SCENARIOS } from '../scripts/lib/cli-help.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'devflow');
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
}

test('devflow help 输出场景入口与 COMMANDS 的全部命令', () => {
  const r = run(['help']);
  assert.equal(r.status, 0, r.stderr);
  for (const [label, entry] of SCENARIOS) {
    assert.ok(r.stdout.includes(`${label} → ${entry}`), `缺少场景入口 ${label}`);
  }
  for (const name of [...Object.keys(COMMANDS), 'help']) {
    assert.match(r.stdout, new RegExp(`^\\s+${name}\\b`, 'm'), `缺少命令 ${name}`);
  }
  for (const [name, [, desc]] of Object.entries(COMMANDS)) {
    assert.ok(r.stdout.includes(desc), `命令 ${name} 的描述未从 COMMANDS 生成`);
  }
});

test('devflow help <命令> 与 <命令> --help 输出一致并包含用法', () => {
  for (const [name, [, desc, usage]] of Object.entries(COMMANDS)) {
    const direct = run(['help', name]);
    const flag = run([name, '--help']);
    const flagWithTarget = run(['--help', name]);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(flag.status, 0, flag.stderr);
    assert.equal(direct.stdout, flag.stdout, `${name} 的两种帮助入口输出不一致`);
    assert.equal(direct.stdout, flagWithTarget.stdout, `--help ${name} 输出不一致`);
    assert.ok(direct.stdout.includes(desc), `${name} 帮助缺少描述`);
    assert.ok(direct.stdout.includes(usage), `${name} 帮助缺少用法`);
  }
});

test('devflow help help 说明自身用法', () => {
  const r = run(['help', 'help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /devflow help <命令>/);
});

test('帮助拒绝未知命令与多个命令名', () => {
  const unknown = run(['help', 'nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知命令/);
  assert.match(unknown.stdout, /按场景选入口/);

  const many = run(['help', 'change', 'status']);
  assert.equal(many.status, 1);
  assert.match(many.stderr, /一次只能查看一个命令/);
});

test('帮助标志不会互相当成未知命令', () => {
  for (const args of [['help', '--help'], ['--help', '-h']]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /按场景选入口/);
  }
});

test('帮助拒绝路径与 shell 元字符，不回显原始输入', () => {
  for (const target of ['/init', 'D:/tmp/init', 'change;rm', '$(id)']) {
    const r = run(['help', target]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /只接受一个命令名/);
    assert.doesNotMatch(r.stderr, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('帮助入口只读，且不会把 --help 透传给子命令', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'devflow-help-readonly-'));
  try {
    for (const args of [['help'], ['help', 'change'], ['test', '--help'], ['init', '-h']]) {
      const r = run(args, { cwd });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readdirSync(cwd), [], `${args.join(' ')} 不应写入任何文件`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('help 技能通过 CLI 取命令列表，允许模型主动调用', () => {
  const body = read('skills/help/SKILL.md');
  assert.match(body, /bin\/devflow" help/);
  assert.doesNotMatch(body, /disable-model-invocation/);
});

test('help 技能先校验参数，不把原始输入直接拼进 shell', () => {
  const body = read('skills/help/SKILL.md');
  assert.doesNotMatch(body, /\$ARGUMENTS/);
  assert.match(body, /\^\[a-z\]\[a-z0-9-\]\*\$/);
});

test('help 技能的回退场景与 SCENARIOS 一致', () => {
  const body = read('skills/help/SKILL.md');
  for (const [, entry] of SCENARIOS) {
    assert.ok(body.includes(entry), `help 技能回退表缺少 ${entry}`);
  }
});

test('COMMANDS 的每条命令都有用法说明，且不暴露内部 --root', () => {
  for (const [name, [, , usage]] of Object.entries(COMMANDS)) {
    assert.ok(usage && usage.trim(), `${name} 缺少 usage`);
    assert.ok(!usage.includes('--root'), `${name} 的用法仍包含内部参数 --root`);
  }
});

test('upstream 与 ship 的帮助包含用户可见参数', () => {
  const upstream = run(['help', 'upstream']).stdout;
  assert.ok(upstream.includes('--personal-library <path>'));
  assert.ok(upstream.includes('--team-library <path>'));
  const ship = run(['help', 'ship']).stdout;
  assert.ok(ship.includes('--plugin-root <dir>'));
  assert.ok(ship.includes('--allow-fork'));
});

test('README 与 quickstart 提供 /devflow:help 入口', () => {
  const readme = read('README.md');
  assert.match(readme, /^\| `\/devflow:help \[命令\]` \|/m);
  assert.ok(readme.includes('不确定用哪个命令时，先运行 `/devflow:help`'));
  assert.ok(read('docs/quickstart.md').includes('`/devflow:help`'));
});
