import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  defaultOps, listArchives, runChange, runRestore,
} from '../scripts/hub-change.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-change.mjs');
const NOW = () => new Date(2026, 10, 10, 15, 30, 12, 123);

function makeTask(files = ['req.md', 'plan.md', 'test.md', 'review.md', 'review-triage.json']) {
  const root = mkdtempSync(join(tmpdir(), 'devflow-restore-'));
  const dir = join(root, 'docs', 'devflow', 'task');
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), `# ${name}\n`);
  return { root, dir };
}

function quiet() {}

function archive(root, options = {}) {
  return runChange({
    root,
    slug: 'task',
    from: 'plan',
    apply: true,
    out: quiet,
    now: NOW,
    ...options,
  });
}

function archiveName(root) {
  const listed = listArchives(root, 'task');
  assert.equal(listed.archives.length, 1, JSON.stringify(listed));
  return listed.archives[0].name;
}

function restore(root, options = {}) {
  return runRestore({
    root,
    slug: 'task',
    archive: 'latest',
    out: quiet,
    now: NOW,
    ...options,
  });
}

function cli(root, args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, '--slug', 'task', ...args], {
    encoding: 'utf8',
  });
}

test('--list 列出归档目录、来源与文件清单', () => {
  const { root } = makeTask();
  try {
    archive(root);
    const listed = listArchives(root, 'task');
    assert.equal(listed.archives.length, 1);
    assert.equal(listed.archives[0].from, 'plan');
    assert.equal(listed.archives[0].flow, 'full');
    assert.deepEqual(listed.archives[0].files, ['test.md', 'review.md', 'review-triage.json']);
    assert.equal(listed.archives[0].error, null);

    const result = cli(root, ['--list', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'list');
    assert.equal(report.archives.length, 1);
    assert.equal(report.archives[0].name, archiveName(root));
    assert.match(result.stderr, /^$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--restore 默认预览，--apply 才恢复', () => {
  const { root, dir } = makeTask();
  try {
    archive(root);
    assert.equal(existsSync(join(dir, 'test.md')), false);

    const preview = restore(root);
    assert.equal(preview.mode, 'restore-preview');
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.restorable, ['test.md', 'review.md', 'review-triage.json']);
    assert.equal(existsSync(join(dir, 'test.md')), false);

    const applied = restore(root, { apply: true });
    assert.equal(applied.mode, 'restore');
    assert.equal(applied.applied, true);
    assert.equal(readFileSync(join(dir, 'test.md'), 'utf8'), '# test.md\n');
    assert.equal(existsSync(join(dir, 'review-triage.json')), true);
    assert.equal(applied.backupDir, null);

    // 归档目录保留 manifest，便于追溯；文件已恢复，remaining 为 0，再次执行是 noop。
    assert.equal(listArchives(root, 'task').archives[0].remaining, 0);
    const again = restore(root, { apply: true });
    assert.equal(again.noop, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('已归档任务（只剩 .archive）也能列出并恢复', () => {
  const { root, dir } = makeTask();
  try {
    runChange({
      root,
      slug: 'task',
      from: 'req',
      purge: true,
      apply: true,
      out: quiet,
      now: NOW,
    });
    assert.equal(existsSync(join(dir, 'req.md')), false);
    const listed = listArchives(root, 'task');
    assert.equal(listed.archives.length, 1);
    assert.deepEqual(listed.archives[0].files, [
      'req.md', 'plan.md', 'test.md', 'review.md', 'review-triage.json',
    ]);

    const cliList = cli(root, ['--list', '--json']);
    assert.equal(cliList.status, 0, cliList.stderr);
    assert.equal(JSON.parse(cliList.stdout).archives.length, 1);

    const restored = cli(root, ['--restore', 'latest', '--apply', '--json']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).applied, true);
    assert.equal(readFileSync(join(dir, 'req.md'), 'utf8'), '# req.md\n');
    assert.equal(existsSync(join(dir, 'review-triage.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目标已存在时默认拒绝覆盖，且不移动任何文件', () => {
  const { root, dir } = makeTask();
  try {
    archive(root);
    writeFileSync(join(dir, 'test.md'), '# 当前的新测试\n');
    const name = archiveName(root);
    assert.throws(
      () => restore(root, { apply: true }),
      /目标已存在：test\.md；确认覆盖请加 --force/,
    );
    assert.equal(readFileSync(join(dir, 'test.md'), 'utf8'), '# 当前的新测试\n');
    // 拒绝发生在移动之前：其他归档文件仍在归档目录。
    assert.equal(existsSync(join(dir, '.archive', name, 'review.md')), true);
    assert.equal(existsSync(join(dir, 'review.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--force 覆盖前把当前文件备份到归档目录', () => {
  const { root, dir } = makeTask();
  try {
    archive(root);
    writeFileSync(join(dir, 'test.md'), '# 当前的新测试\n');
    const report = restore(root, { apply: true, force: true });
    assert.equal(readFileSync(join(dir, 'test.md'), 'utf8'), '# test.md\n');
    assert.ok(report.backupDir);
    assert.match(report.backupDir, /replaced-20261110-153012-123$/);
    assert.equal(readFileSync(join(root, report.backupDir, 'test.md'), 'utf8'), '# 当前的新测试\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest 只允许已知产物，路径或未知文件直接拒绝', () => {
  const { root, dir } = makeTask();
  try {
    archive(root);
    const name = archiveName(root);
    const manifestFile = join(dir, '.archive', name, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

    for (const bad of ['../outside.md', 'evil.md', 'manifest.json']) {
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, files: [...manifest.files, bad] }));
      assert.throws(() => restore(root, { archive: name, apply: true }), /不允许恢复的文件/);
      assert.equal(existsSync(join(dir, 'test.md')), false);
    }

    writeFileSync(manifestFile, JSON.stringify({ ...manifest, slug: 'other' }));
    assert.throws(() => restore(root, { archive: name, apply: true }), /与当前 slug task 不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--restore 只接受归档目录名或 latest', () => {
  const { root } = makeTask();
  try {
    archive(root);
    const bad = cli(root, ['--restore', '../escape']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /非法的归档名/);

    const missing = cli(root, ['--restore', '20200101-000000-000']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /未找到归档/);

    const latest = cli(root, ['--restore', 'latest', '--apply', '--json']);
    assert.equal(latest.status, 0, latest.stderr);
    const report = JSON.parse(latest.stdout);
    assert.equal(report.applied, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--list 与 --apply、--from 互斥', () => {
  const { root } = makeTask();
  try {
    archive(root);
    const withApply = cli(root, ['--list', '--apply']);
    assert.equal(withApply.status, 1);
    assert.match(withApply.stderr, /--list 是只读操作/);

    const withFrom = cli(root, ['--list', '--from', 'plan']);
    assert.equal(withFrom.status, 1);
    assert.match(withFrom.stderr, /不能与 --from 同时使用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('恢复中途失败时逆序回滚，归档与目标都回到原状', () => {
  const { root, dir } = makeTask();
  try {
    archive(root);
    const name = archiveName(root);
    let calls = 0;
    const ops = {
      ...defaultOps,
      rename(from, to) {
        calls += 1;
        if (calls === 2) throw new Error('模拟移动失败');
        return defaultOps.rename(from, to);
      },
    };
    assert.throws(() => restore(root, { archive: name, apply: true, ops }), /模拟移动失败/);
    assert.equal(existsSync(join(dir, 'test.md')), false);
    assert.equal(existsSync(join(dir, '.archive', name, 'test.md')), true);
    assert.equal(existsSync(join(dir, '.archive', name, 'review.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
