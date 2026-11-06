import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contentHash } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // 隔离宿主机环境：缓存落在当前用例临时目录，禁用凭据交互与远程来源回退。
      DEVFLOW_CACHE_DIR: join(cwd, 'cache'),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      DEVFLOW_STACK_REPO: '',
      ...env,
    },
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

test('显式 --from 优先于 DEVFLOW_STACK_REPO 环境变量', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-env-from-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'],
      root,
      { DEVFLOW_STACK_REPO: 'https://example.com/stacks.git' },
    );
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), /plan/);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'].source, 'local');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack add --dry-run 不写目标目录、账本与 lock', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-dry-run-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--dry-run'], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
    assert.equal(existsSync(join(root, '.claude', '.stack-sources.json')), false);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stack-lock.yaml')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('非法 --as 被拒绝且不创建目标目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-bad-as-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--as', '../x', '--no-gen'],
      root,
    );
    assert.notEqual(res.status, 0, res.stdout);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'x')), false);
    assert.equal(res.stderr.includes('../x'), false, res.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--from 与 --ref / --offline 互斥', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-exclusive-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const withRef = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--ref', 'v1', '--no-gen'],
      root,
    );
    const withOffline = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--offline', '--no-gen'],
      root,
    );
    assert.notEqual(withRef.status, 0, withRef.stdout);
    assert.notEqual(withOffline.status, 0, withOffline.stdout);
    assert.match(withRef.stderr, /互斥/);
    assert.match(withOffline.stderr, /互斥/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function makeGitStackRepo(base, options = {}) {
  const {
    dir = 'git-stacks', packId = 'java-spring', version = '1.2.0', text = '# shared\n',
  } = options;
  const repo = join(base, dir);
  mkdirSync(repo, { recursive: true });
  const g = (args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
  };
  g(['init', '-b', 'main']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'test']);
  const packDir = join(repo, 'stacks', packId);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, '_shared.md'), text);
  writeFileSync(join(packDir, 'stack.json'), JSON.stringify({
    name: packId, version, minDevflow: '>=1.7.0',
    detects: ['java-maven'], files: { '_shared.md': contentHash(text) },
  }));
  writeFileSync(join(repo, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    packs: { [packId]: { path: `stacks/${packId}`, detects: ['java-maven'] } },
  }));
  g(['add', '.']);
  g(['commit', '-m', 'init']);
  return repo;
}

function gitHead(repo) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  return res.stdout.trim();
}

function commitRepo(repo, message) {
  const g = (args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
  };
  g(['add', '.']);
  g(['commit', '-m', message]);
}

test('update 推进 ref 并保留本地改动，restore 按 lock 恢复', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-update-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const env = { DEVFLOW_CACHE_DIR: join(base, 'cache'), DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen'],
      root,
      env,
    );
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    // 本地新增文件属于本地改动，update 不得静默删除。
    writeFileSync(join(stackDir, 'local.md'), '# local\n');

    const v2 = '# shared v2\n';
    writeFileSync(join(repo, 'stacks', 'java-spring', '_shared.md'), v2);
    const manifestFile = join(repo, 'stacks', 'java-spring', 'stack.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.version = '1.3.0';
    manifest.files['_shared.md'] = contentHash(v2);
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    commitRepo(repo, 'v2');

    const ledgerFile = join(root, '.claude', '.stack-sources.json');
    const before = JSON.parse(readFileSync(ledgerFile, 'utf8')).packs['java-spring'].commit;
    const update = run('hub-stack.mjs', ['update', 'java-spring', '--root', root, '--no-gen'], root, env);
    assert.equal(update.status, 0, update.stderr + update.stdout);
    assert.equal(readFileSync(join(stackDir, '_shared.md'), 'utf8'), v2);
    assert.equal(existsSync(join(stackDir, 'local.md')), true);
    const after = JSON.parse(readFileSync(ledgerFile, 'utf8')).packs['java-spring'].commit;
    assert.match(after, /^[0-9a-f]{40}$/);
    assert.notEqual(after, before);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stack-lock.yaml'), 'utf8'), new RegExp(after));

    rmSync(stackDir, { recursive: true, force: true });
    const restore = run('hub-stack.mjs', ['restore', '--root', root, '--no-gen'], root, env);
    assert.equal(restore.status, 0, restore.stderr + restore.stdout);
    assert.equal(readFileSync(join(stackDir, '_shared.md'), 'utf8'), v2);
    assert.equal(existsSync(join(stackDir, 'local.md')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('restore 对内容不一致的目录保留本地并在 --force 时覆盖', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-restore-modified-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const env = { DEVFLOW_CACHE_DIR: join(base, 'cache'), DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen'],
      root,
      env,
    );
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    const edited = '# hand edited\n';
    writeFileSync(join(stackDir, '_shared.md'), edited);

    const rel = '.claude/hub/stacks/java-spring/_shared.md';
    const ledgerFile = join(root, '.claude', '.stack-sources.json');
    const basesFile = join(root, '.claude', '.stack-bases', 'java-spring', '_shared.md');

    const kept = run('hub-stack.mjs', ['restore', '--root', root, '--no-gen'], root, env);
    assert.equal(kept.status, 0, kept.stderr + kept.stdout);
    assert.match(kept.stdout, /保留本地/);
    assert.equal(readFileSync(join(stackDir, '_shared.md'), 'utf8'), edited);
    // bases 与账本 base 必须切到 lock 的包内容，local 记录实际手改内容。
    assert.equal(readFileSync(basesFile, 'utf8'), '# shared\n');
    const record = JSON.parse(readFileSync(ledgerFile, 'utf8')).packs['java-spring'];
    assert.equal(record.files[rel].base, contentHash('# shared\n'));
    assert.equal(record.files[rel].local, contentHash(edited));

    const forced = run('hub-stack.mjs', ['restore', '--root', root, '--force', '--no-gen'], root, env);
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);
    assert.equal(readFileSync(join(stackDir, '_shared.md'), 'utf8'), '# shared\n');
    const after = JSON.parse(readFileSync(ledgerFile, 'utf8')).packs['java-spring'];
    assert.equal(after.files[rel].local, contentHash('# shared\n'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('restore 拒绝来源与本地账本不一致的 lock', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-restore-owner-'));
  try {
    const root = makeProject(base);
    const repoA = makeGitStackRepo(base);
    const repoB = makeGitStackRepo(base, { dir: 'git-stacks-b' });
    const env = { DEVFLOW_CACHE_DIR: join(base, 'cache'), DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repoA, '--ref', 'main', '--no-gen'],
      root,
      env,
    );
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const ledgerFile = join(root, '.claude', '.stack-sources.json');
    const before = readFileSync(ledgerFile, 'utf8');
    // 换成另一仓库的 lock：installedAs/packId 相同但 repo 不同。
    writeFileSync(join(root, '.claude', 'hub', 'stack-lock.yaml'), [
      'version: 1',
      'packs:',
      '  java-spring:',
      '    installedAs: java-spring',
      `    repo: '${repoB.replace(/\\/g, '/')}'`,
      '    packId: java-spring',
      '    path: stacks/java-spring',
      '    ref: main',
      `    commit: '${gitHead(repoB)}'`,
      '    version: 1.2.0',
      '',
    ].join('\n'));

    const res = run('hub-stack.mjs', ['restore', '--root', root, '--no-gen'], root, env);
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /先运行 devflow stack remove/);
    assert.equal(readFileSync(ledgerFile, 'utf8'), before);

    const forced = run('hub-stack.mjs', ['restore', '--root', root, '--force', '--no-gen'], root, env);
    assert.notEqual(forced.status, 0, forced.stdout);
    assert.match(forced.stderr, /先运行 devflow stack remove/);
    assert.equal(readFileSync(ledgerFile, 'utf8'), before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('restore 拒绝被篡改的 lock 包路径', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-restore-path-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const env = { DEVFLOW_CACHE_DIR: join(base, 'cache'), DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen'],
      root,
      env,
    );
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const lockFile = join(root, '.claude', 'hub', 'stack-lock.yaml');
    writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace(/path: '[^']*'/, "path: 'stacks/other'"));

    const res = run('hub-stack.mjs', ['restore', '--root', root, '--no-gen'], root, env);
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /包路径不一致/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update --dry-run 输出动作但不落盘', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-update-dry-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const env = { DEVFLOW_CACHE_DIR: join(base, 'cache'), DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen'],
      root,
      env,
    );
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const ledgerFile = join(root, '.claude', '.stack-sources.json');
    const before = readFileSync(ledgerFile, 'utf8');
    const v2 = '# shared v2\n';
    writeFileSync(join(repo, 'stacks', 'java-spring', '_shared.md'), v2);
    const manifestFile = join(repo, 'stacks', 'java-spring', 'stack.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.files['_shared.md'] = contentHash(v2);
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    commitRepo(repo, 'v2');

    const dry = run(
      'hub-stack.mjs',
      ['update', 'java-spring', '--root', root, '--dry-run', '--no-gen'],
      root,
      env,
    );
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /_shared\.md/);
    assert.equal(readFileSync(ledgerFile, 'utf8'), before);
    assert.equal(
      readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'),
      '# shared\n',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('remove 在被 hub.yaml 引用时拒绝，--force 被拒，--keep 保留目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-remove-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
    writeFileSync(hubFile, readFileSync(hubFile, 'utf8').replace('stages:', 'stack: java-spring\nstages:'));

    const refused = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--no-gen'], root);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /引用/);

    const forced = run(
      'hub-stack.mjs',
      ['remove', 'java-spring', '--root', root, '--force', '--no-gen'],
      root,
    );
    assert.notEqual(forced.status, 0, forced.stdout);
    assert.match(forced.stderr, /不接受 --force/);

    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    const kept = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--keep', '--no-gen'], root);
    assert.equal(kept.status, 0, kept.stderr + kept.stdout);
    assert.equal(existsSync(stackDir), true);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'], undefined);
    assert.equal(existsSync(join(root, '.claude', '.stack-bases', 'java-spring')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('remove --purge 只删除未改文件并保留手改与额外文件', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-purge-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    writeFileSync(join(stackDir, 'plan.md'), '# hand edited\n');
    writeFileSync(join(stackDir, 'extra.md'), '# extra\n');

    const res = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--purge', '--no-gen'], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(existsSync(join(stackDir, '_shared.md')), false);
    assert.equal(readFileSync(join(stackDir, 'plan.md'), 'utf8'), '# hand edited\n');
    assert.equal(readFileSync(join(stackDir, 'extra.md'), 'utf8'), '# extra\n');
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'], undefined);
    assert.equal(existsSync(join(root, '.claude', '.stack-bases', 'java-spring')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('remove 默认把目录与 bases 移入 trash 并清除账本', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-remove-default-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(add.status, 0, add.stderr + add.stdout);

    const res = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--no-gen'], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
    assert.equal(existsSync(join(root, '.claude', '.stack-bases', 'java-spring')), false);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'], undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('remove 删除 lock 条目且 --dry-run 不写入', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-remove-lock-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const env = { DEVFLOW_CACHE_DIR: join(base, 'cache'), DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen'],
      root,
      env,
    );
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    const ledgerFile = join(root, '.claude', '.stack-sources.json');
    const lockFile = join(root, '.claude', 'hub', 'stack-lock.yaml');
    const ledgerBefore = readFileSync(ledgerFile, 'utf8');
    const lockBefore = readFileSync(lockFile, 'utf8');
    assert.match(lockBefore, /java-spring/);

    const dry = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--dry-run', '--no-gen'], root, env);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.equal(existsSync(stackDir), true);
    assert.equal(readFileSync(ledgerFile, 'utf8'), ledgerBefore);
    assert.equal(readFileSync(lockFile, 'utf8'), lockBefore);

    const res = run('hub-stack.mjs', ['remove', 'java-spring', '--root', root, '--no-gen'], root, env);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(existsSync(stackDir), false);
    assert.equal(existsSync(join(root, '.claude', '.stack-bases', 'java-spring')), false);
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    assert.equal(ledger.packs['java-spring'], undefined);
    assert.equal(existsSync(lockFile), true);
    assert.doesNotMatch(readFileSync(lockFile, 'utf8'), /java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

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
    const res = run('hub-stack.mjs', ['lock', '--root', root], root);
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
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    // Task 8：快照位于 <cache>/<repo-id>/snapshots/<commit>/，逐仓库目录收集 meta。
    const metas = [];
    for (const repoDir of readdirSync(cache)) {
      const snapshots = join(cache, repoDir, 'snapshots');
      if (!existsSync(snapshots)) continue;
      for (const commit of readdirSync(snapshots)) {
        for (const name of readdirSync(join(snapshots, commit))) {
          if (name.endsWith('.meta.json')) metas.push(join(snapshots, commit, name));
        }
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

test('stack lock 保留未知顶层字段与 git 条目', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-lock-keep-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const lockFile = join(root, '.claude', 'hub', 'stack-lock.yaml');
    writeFileSync(lockFile, `${readFileSync(lockFile, 'utf8')}futureField: keep-me\n`);

    const res = run('hub-stack.mjs', ['lock', '--root', root], root, env);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const lock = readFileSync(lockFile, 'utf8');
    assert.match(lock, /futureField: keep-me/);
    assert.match(lock, /repo:/);
    assert.match(lock, /ref:/);
    assert.match(lock, /commit:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack add --offline 使用已缓存快照完成安装', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-offline-hit-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    // 原仓库不可达后，离线安装必须完全依赖 bare 缓存与已验证快照。
    rmSync(repo, { recursive: true, force: true });
    const again = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', repo, '--offline', '--force', '--no-gen'],
      root,
      env,
    );
    assert.equal(again.status, 0, again.stderr + again.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack add --offline 在缓存缺失时失败', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-offline-miss-'));
  try {
    const root = makeProject(base);
    const res = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--repo', 'https://example.com/stacks.git', '--offline', '--no-gen'],
      root,
      { DEVFLOW_CACHE_DIR: join(base, 'empty-cache') },
    );
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /离线/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack list --json 输出纯 JSON', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-list-json-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const res = run('hub-stack.mjs', ['list', '--root', root, '--json'], root, env);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(JSON.parse(res.stdout).installed[0].installedAs, 'java-spring');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack add --repo 拒绝 index.json 中的越界包路径', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-bad-path-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const git = (args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr + res.stdout);
    };
    writeFileSync(join(repo, 'index.json'), JSON.stringify({
      schemaVersion: 1,
      packs: { 'java-spring': { path: 'stacks/../evil', detects: ['java-maven'] } },
    }));
    git(['add', '.']);
    git(['commit', '-m', 'bad index']);

    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const res = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /包路径非法/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack cache gc 拒绝非正整数 --keep-days', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-keep-days-'));
  try {
    const res = run(
      'hub-stack.mjs',
      ['cache', 'gc', '--root', base, '--keep-days', '-1'],
      base,
      { DEVFLOW_CACHE_DIR: join(base, 'empty-cache') },
    );
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /--keep-days 必须是正整数/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack cache gc 在非 devflow 目录可执行', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-gc-anywhere-'));
  try {
    const res = run(
      'hub-stack.mjs',
      ['cache', 'gc', '--root', base],
      base,
      { DEVFLOW_CACHE_DIR: join(base, 'empty-cache') },
    );
    assert.equal(res.status, 0, res.stderr + res.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack 技能存在且禁止模型自动调用', () => {
  const file = join(PLUGIN_ROOT, 'skills', 'stack', 'SKILL.md');
  assert.equal(existsSync(file), true);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---[\s\S]*name:\s*stack[\s\S]*---/);
  assert.match(text, /disable-model-invocation:\s*true/);
});

test('CLI 帮助包含 stack 安装示例', () => {
  const help = spawnSync(NODE, [join(PLUGIN_ROOT, 'bin', 'devflow'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /devflow stack add java-spring --repo/);
});
