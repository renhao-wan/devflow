import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

function makePlugin(base, files) {
  const repo = join(base, 'plugin');
  mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
  writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'devflow',
    version: '1.0.0',
    license: 'MIT',
  }, null, 2));
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n');
  const all = {};
  for (const stage of STAGES) {
    all[`templates/stages/${stage}/SKILL.md`] = `---\nname: ${stage}\ndescription: ${stage}\n---\n\n${stage} v1\n`;
  }
  for (const [rel, content] of Object.entries({ ...all, ...files })) {
    const file = join(repo, ...rel.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return repo;
}

function makeProject(base, pluginRoot) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sync-proj', scripts: { test: 'node --test' } }));
  const init = run('hub-init.mjs', ['--root', root, '--plugin-root', pluginRoot], root);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return root;
}

test('sync 更新未改文件、保留手改、加入新资源', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/req/SKILL.md': '---\nname: req\ndescription: 需求\n---\n\nreq v1\n',
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\nreview v1\n',
    });
    const root = makeProject(base, repo);

    // 插件侧升级模板
    writeFileSync(join(repo, 'templates', 'stages', 'req', 'SKILL.md'), '---\nname: req\ndescription: 需求\n---\n\nreq v2\n');
    writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'), '---\nname: review\ndescription: 评审\n---\n\nreview v2\n');
    mkdirSync(join(repo, 'templates', 'stages', 'review', 'references'), { recursive: true });
    writeFileSync(join(repo, 'templates', 'stages', 'review', 'references', 'new.md'), '# 新参考\n');

    // 项目侧手改 review
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '---\nname: review\ndescription: 评审\n---\n\n本地手改\n');

    const dry = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--dry-run'], root);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /冲突 .*review\/SKILL\.md/);
    assert.match(dry.stdout, /新增 .*references\/new\.md/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /本地手改/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stages', 'review', 'references', 'new.md')), false);

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'req', 'SKILL.md'), 'utf8'), /req v2/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /本地手改/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'references', 'new.md'), 'utf8'), /新参考/);
    assert.match(sync.stdout, /冲突/);

    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.ok(sources.files['.claude/hub/stages/review/references/new.md']);
    assert.ok(sources.files['.claude/hub/stages/req/SKILL.md']);

    const projections = readFileSync(join(root, '.claude', 'skills', 'devflow-req', 'SKILL.md'), 'utf8');
    assert.match(projections, /devflow \/ req/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 为老项目补入新增的 brief 模板', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-light-'));
  try {
    const repo = makePlugin(base, {});
    const root = makeProject(base, repo);

    mkdirSync(join(repo, 'templates', 'stages', 'req', 'templates'), { recursive: true });
    writeFileSync(
      join(repo, 'templates', 'stages', 'req', 'templates', 'brief.template.md'),
      '---\nmode: light\n---\n\n# 轻量功能\n',
    );

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    const target = join(root, '.claude', 'hub', 'stages', 'req', 'templates', 'brief.template.md');
    assert.ok(existsSync(target));
    assert.match(readFileSync(target, 'utf8'), /mode: light/);
    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.ok(sources.files['.claude/hub/stages/req/templates/brief.template.md']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync --force 覆盖时生成 .bak 备份', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-force-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\nreview v1\n',
    });
    const root = makeProject(base, repo);
    writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'), '---\nname: review\ndescription: 评审\n---\n\nreview v2\n');
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '本地手改\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--force'], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /review v2/);

    const files = readdirSync(join(root, '.claude', 'hub', 'stages', 'review'));
    const backup = files.find((f) => f.startsWith('SKILL.md.bak-'));
    assert.ok(backup, `未生成备份：${files.join('、')}`);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', backup), 'utf8'), /本地手改/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 在缺少源文件账本时要求 --force 才覆盖', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-legacy-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\nreview v2\n',
    });
    const root = makeProject(base, repo);
    rmSync(join(root, '.claude', '.hub-sources.json'));
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '旧项目内容\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /缺少 .claude\/.hub-sources.json/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /旧项目内容/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 不复制备份/临时文件，并刷新 pluginRoot', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-artifacts-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md.bak-20260101': '备份\n',
      'templates/stages/review/SKILL.md.tmp-1234': '临时\n',
      'templates/stages/review/.DS_Store': 'x',
    });
    const root = makeProject(base, repo);

    const installed = makePlugin(join(base, 'installed'), {});
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', installed], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);

    const stageDir = join(root, '.claude', 'hub', 'stages', 'review');
    assert.equal(existsSync(join(stageDir, 'SKILL.md.bak-20260101')), false);
    assert.equal(existsSync(join(stageDir, 'SKILL.md.tmp-1234')), false);
    assert.equal(existsSync(join(stageDir, '.DS_Store')), false);

    const meta = JSON.parse(readFileSync(join(root, '.devflow.json'), 'utf8'));
    assert.equal(meta.pluginRoot, installed);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 归一化行尾，兼容旧账本的原始哈希', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-crlf-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\nreview v1\n',
    });
    const root = makeProject(base, repo);
    const dest = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');

    // 仅行尾不同不算冲突
    writeFileSync(dest, readFileSync(dest, 'utf8').replace(/\n/g, '\r\n'));
    const same = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--dry-run'], root);
    assert.equal(same.status, 0, same.stderr + same.stdout);
    assert.match(same.stdout, /冲突 0/);
    assert.match(same.stdout, /更新 0/);

    // 旧账本记录原始哈希：模板升级后应识别为“未手改”，直接更新
    const sourcesFile = join(root, '.claude', '.hub-sources.json');
    const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'));
    const rel = '.claude/hub/stages/review/SKILL.md';
    sources.files[rel] = createHash('sha256').update(readFileSync(dest, 'utf8'), 'utf8').digest('hex');
    writeFileSync(sourcesFile, JSON.stringify(sources, null, 2));
    writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 评审\n---\n\nreview v2\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /更新 .*review\/SKILL\.md/);
    assert.doesNotMatch(sync.stdout, /冲突 .*review\/SKILL\.md/);
    assert.match(readFileSync(dest, 'utf8'), /review v2/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 以安装的插件版本为准，不读取回灌源码仓库', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-source-'));
  try {
    const installed = makePlugin(base, {});
    const source = join(base, 'source');
    mkdirSync(join(source, '.claude-plugin'), { recursive: true });
    mkdirSync(join(source, 'templates', 'stages', 'review'), { recursive: true });
    writeFileSync(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version: '9.9.9' }));
    writeFileSync(join(source, 'templates', 'stages', 'review', 'SKILL.md'), '未发布的模板\n');

    const root = makeProject(base, installed);
    const metaFile = join(root, '.devflow.json');
    writeFileSync(metaFile, JSON.stringify({
      ...JSON.parse(readFileSync(metaFile, 'utf8')),
      pluginSourceRoot: source,
    }, null, 2));

    const dry = run('hub-sync.mjs', ['--root', root, '--dry-run'], root);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /更新 0/);
    assert.match(dry.stdout, /冲突 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 拒绝通过 junction 写到项目外', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证 junction');
    return;
  }
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-junction-'));
  let junction = null;
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\nreview v1\n',
    });
    const root = makeProject(base, repo);

    const outside = join(base, 'outside');
    mkdirSync(outside);
    const stageDir = join(root, '.claude', 'hub', 'stages', 'review');
    rmSync(stageDir, { recursive: true, force: true });
    const link = spawnSync('cmd', ['/c', 'mklink', '/J', stageDir, outside], { encoding: 'utf8' });
    if (link.status !== 0) {
      t.skip('mklink /J 不可用');
      return;
    }
    junction = stageDir;

    writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 评审\n---\n\nreview v2\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /越界/);
    assert.equal(existsSync(join(outside, 'SKILL.md')), false);
  } finally {
    if (junction) spawnSync('cmd', ['/c', 'rmdir', junction], { encoding: 'utf8' });
    rmSync(base, { recursive: true, force: true });
  }
});
