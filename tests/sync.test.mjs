import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DRAFT_MARKER } from '../scripts/lib/common.mjs';

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
    assert.match(sync.stdout, /手工合并后重新运行 \/devflow:sync/);
    assert.match(sync.stdout, /--force/);
    assert.match(sync.stdout, /\.bak/);

    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.ok(sources.files['.claude/hub/stages/review/references/new.md']);
    assert.ok(sources.files['.claude/hub/stages/req/SKILL.md']);
    assert.equal(sources.files['.claude/hub/stages/review/SKILL.md']?.source, 'upstream');

    // 冲突时已把当前模板记为基线：模板未再变化时重跑不应重复报冲突，本地手改仍保留。
    const again = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.doesNotMatch(again.stdout, /冲突 .*review\/SKILL\.md/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /本地手改/);

    const projections = readFileSync(join(root, '.claude', 'skills', 'devflow-req', 'SKILL.md'), 'utf8');
    assert.match(projections, /devflow \/ req/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 同步技术栈模板并保留本地手改', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-stacks-'));
  try {
    const repo = makePlugin(base, {
      'templates/stacks/java-spring/_shared.md': '# Java v1\n',
      'templates/stacks/java-spring/plan.md': '# Java plan v1\n',
    });
    const root = makeProject(base, repo);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), /Java v1/);

    writeFileSync(join(repo, 'templates', 'stacks', 'java-spring', '_shared.md'), '# Java v2\n');
    writeFileSync(join(repo, 'templates', 'stacks', 'java-spring', 'review.md'), '# Java review\n');
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), '# 本地方案规范\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), /Java v2/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'review.md'), 'utf8'), /Java review/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), /本地方案规范/);
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

test('sync 对双方都修改的文件做三方合并', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-merge-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\nreview v1\n',
    });
    const root = makeProject(base, repo);

    const local = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');
    writeFileSync(local, '---\nname: review\ndescription: 评审\n---\n\nreview v1\n\n本地追加\n');
    writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 评审\n---\n\n模板新增\n\nreview v1\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /自动合并/);

    const merged = readFileSync(local, 'utf8');
    assert.match(merged, /本地追加/);
    assert.match(merged, /模板新增/);

    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    const record = sources.files['.claude/hub/stages/review/SKILL.md'];
    assert.equal(sources.schemaVersion, 3);
    assert.ok(record.base);
    assert.equal(record.source, 'upstream');
    // 合并结果含本地改动，账本 local 只能记录同步写入的模板内容。
    assert.equal(record.local, record.base);

    // 模板未再变化时重跑：必须保留合并结果，不能被原始模板覆盖。
    const again = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /保留手改/);
    const preserved = readFileSync(local, 'utf8');
    assert.match(preserved, /本地追加/);
    assert.match(preserved, /模板新增/);
    const after = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(after.files['.claude/hub/stages/review/SKILL.md'].local,
      after.files['.claude/hub/stages/review/SKILL.md'].base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 同步共享模板并从模板初始复制', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-shared-'));
  try {
    const repo = makePlugin(base, {
      'templates/shared/common.md': '共享 v1\n',
    });
    const root = makeProject(base, repo);

    const target = join(root, '.claude', 'hub', '_shared', 'common.md');
    assert.equal(readFileSync(target, 'utf8'), '共享 v1\n');

    writeFileSync(join(repo, 'templates', 'shared', 'common.md'), '共享 v2\n');
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.equal(readFileSync(target, 'utf8'), '共享 v2\n');

    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.ok(sources.files['.claude/hub/_shared/common.md']);
    assert.ok(existsSync(join(root, '.claude', '.hub-bases', '_shared', 'common.md')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function writeLibraryFile(root, rel, content) {
  const file = join(root, 'templates', ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

test('sync 保留项目草稿，--force 也不覆盖', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-draft-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\n上游 review\n',
      'templates/stages/review/references/project-note.md': '# 上游参考\n',
    });
    const root = makeProject(base, repo);
    const target = join(root, '.claude', 'hub', 'stages', 'review', 'references', 'project-note.md');
    const draft = `${DRAFT_MARKER}\n# 评审参考草稿\n\n- TODO: 补充项目约定。\n`;
    writeFileSync(target, draft);

    const dry = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--dry-run'], root);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /保留项目草稿 1/);
    assert.equal(readFileSync(target, 'utf8'), draft);

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--force'], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /保留项目草稿 1/);
    assert.equal(readFileSync(target, 'utf8'), draft);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 跳过模板库草稿，不写入项目', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-template-draft-'));
  try {
    const repo = makePlugin(base, {});
    const root = makeProject(base, repo);
    const personal = join(base, 'personal');
    writeLibraryFile(personal, 'stages/plan/references/draft.md', `${DRAFT_MARKER}\n# 模板草稿\n\n- TODO: 补充。\n`);

    const args = ['--root', root, '--plugin-root', repo, '--personal-library', personal];
    const dry = run('hub-sync.mjs', [...args, '--dry-run'], root);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /跳过草稿 1（其中模板库草稿 1）/);

    const sync = run('hub-sync.mjs', args, root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /跳过草稿 1（其中模板库草稿 1）/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stages', 'plan', 'references', 'draft.md')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 优先使用个人库，个人模板移除后回落到上游', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-personal-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\n上游 review\n',
    });
    const root = makeProject(base, repo);
    const personal = join(base, 'personal');
    writeLibraryFile(personal, 'stages/review/SKILL.md', '---\nname: review\ndescription: 评审\n---\n\n个人 review\n');

    const args = ['--root', root, '--plugin-root', repo, '--personal-library', personal];
    const first = run('hub-sync.mjs', args, root);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /\[personal\]/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /个人 review/);

    let sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(sources.files['.claude/hub/stages/review/SKILL.md'].source, 'personal');

    // 高优先库删除后，低优先上游仍提供同名文件：应回落而不是误报“模板已移除”。
    rmSync(join(personal, 'templates', 'stages', 'review', 'SKILL.md'));
    const second = run('hub-sync.mjs', args, root);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.doesNotMatch(second.stdout, /模板已移除/);
    assert.match(second.stdout, /\[upstream\]/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /上游 review/);

    sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(sources.files['.claude/hub/stages/review/SKILL.md'].source, 'upstream');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 团队库覆盖个人库同名模板', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-team-'));
  try {
    const repo = makePlugin(base, {
      'templates/stages/review/SKILL.md': '---\nname: review\ndescription: 评审\n---\n\n上游 review\n',
    });
    const root = makeProject(base, repo);
    const personal = join(base, 'personal');
    const team = join(base, 'team');
    writeLibraryFile(personal, 'stages/review/SKILL.md', '---\nname: review\ndescription: 评审\n---\n\n个人 review\n');
    writeLibraryFile(team, 'stages/review/SKILL.md', '---\nname: review\ndescription: 评审\n---\n\n团队 review\n');

    const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
    const patched = readFileSync(hubFile, 'utf8')
      .replace('order: [personal, upstream]', 'order: [team, personal, upstream]')
      .replace('  # team:\n', `  team:\n    enabled: true\n    path: ${JSON.stringify(team.replace(/\\/g, '/'))}\n`);
    writeFileSync(hubFile, patched);

    const sync = run('hub-sync.mjs', [
      '--root', root, '--plugin-root', repo, '--personal-library', personal, '--team-library', team,
    ], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /\[team\]/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), 'utf8'), /团队 review/);

    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(sources.files['.claude/hub/stages/review/SKILL.md'].source, 'team');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 来源切换到内容相同的个人模板时保留本地改动并更新来源', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-switch-'));
  try {
    const upstreamText = '---\nname: review\ndescription: 评审\n---\n\nreview v1\n';
    const repo = makePlugin(base, { 'templates/stages/review/SKILL.md': upstreamText });
    const root = makeProject(base, repo);
    const personal = join(base, 'personal');
    writeLibraryFile(personal, 'stages/review/SKILL.md', upstreamText);

    const target = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');
    writeFileSync(target, `${upstreamText}\n本地追加\n`);

    const sync = run('hub-sync.mjs', [
      '--root', root, '--plugin-root', repo, '--personal-library', personal,
    ], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /保留手改/);
    assert.match(readFileSync(target, 'utf8'), /本地追加/);

    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(sources.files['.claude/hub/stages/review/SKILL.md'].source, 'personal');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 兼容 v2 账本并在下次同步升级为 v3', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-sync-v2-'));
  try {
    const repo = makePlugin(base, {});
    const root = makeProject(base, repo);
    const sourcesFile = join(root, '.claude', '.hub-sources.json');
    const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'));
    sources.schemaVersion = 2;
    for (const value of Object.values(sources.files)) delete value.source;
    writeFileSync(sourcesFile, JSON.stringify(sources, null, 2));

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    const next = JSON.parse(readFileSync(sourcesFile, 'utf8'));
    assert.equal(next.schemaVersion, 3);
    assert.equal(next.files['.claude/hub/stages/req/SKILL.md'].source, 'upstream');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
