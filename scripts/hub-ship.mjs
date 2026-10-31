#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, projectRoot, pluginInfo,
  readText, log, posix, isMain, resolveUpstreamRoot, isPluginCache, cacheGuardMessage,
  bumpVersion, samePath,
} from './lib/common.mjs';
import { main as upstream } from './hub-upstream.mjs';

const WHITELIST = [
  (p) => p === '.claude-plugin/plugin.json',
  (p) => p === '.claude-plugin/marketplace.json',
  (p) => p === 'package.json',
  (p) => p === 'CHANGELOG.md',
  (p) => p === 'templates/stages/_feedback-log.md',
  (p) => p.startsWith('templates/stages/'),
];

function isWhitelisted(path) {
  const p = path.replace(/\\/g, '/');
  return WHITELIST.some((match) => match(p));
}

/** 日志里去掉 URL 中可能存在的用户名/token。 */
function redactUrl(url) {
  return String(url).replace(/\/\/([^/@]+)@/, '//***@');
}

function git(cwd, args, extra = []) {
  return spawnSync('git', [...args, ...extra], { cwd, encoding: 'utf8' });
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout.trim();
}

function dirty(cwd) {
  const r = git(cwd, ['status', '--porcelain=v1', '-z']);
  if (r.status !== 0) {
    throw new Error(`git status 失败：${(r.stderr || '').trim()}`);
  }
  const entries = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    out.push({ status, path: entry.slice(3).replace(/\\/g, '/') });
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return out;
}

function githubRemote(url) {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function uniqueBranch(cwd, base) {
  let name = base;
  let i = 2;
  for (;;) {
    const local = git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
    const remote = git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]).status === 0;
    if (!local && !remote) return name;
    name = `${base}-${i}`;
    i += 1;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function compareUrl(owner, repo, base, branch) {
  return `https://github.com/${owner}/${repo}/compare/${base}...${branch}?expand=1`;
}

/** 复用仓库 PR 模板，没有模板时退回内置结构。 */
export function buildPrBody(pluginRoot, { stage, projectName, files, oldVersion, newVersion, kind }) {
  const tplFile = join(pluginRoot, '.github', 'pull_request_template.md');
  const sections = {
    '变更内容': `## 变更内容\n\n回灌 ${stage} 阶段规则，来源项目：${projectName}。`,
    '类型': '## 类型\n\n- [x] feat',
    '关联': `## 关联\n\n- 阶段：${stage}`,
    '验证': [
      '## 验证',
      '',
      '- [ ] `node --test` 全绿',
      '- [ ] `node scripts/hub-doctor.mjs` 无漂移、无缺失资源',
      '- [x] 手动验证：项目侧回灌预览已确认',
    ].join('\n'),
    '影响面': [
      '## 影响面',
      '',
      `- 影响范围：${files.join('、')}`,
      `- 兼容性：版本 ${oldVersion} → ${newVersion}（${kind}）`,
    ].join('\n'),
  };

  if (existsSync(tplFile)) {
    let body = readText(tplFile);
    for (const [title, replacement] of Object.entries(sections)) {
      body = body.replace(new RegExp(`## ${title}[\\s\\S]*?(?=\\n## |$)`), replacement);
    }
    if (body.trim()) return body.trimEnd() + '\n';
  }
  return Object.values(sections).join('\n\n') + '\n';
}

async function createPrViaApi(owner, repo, base, branch, title, body, token) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'devflow-ship',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, head: branch, base, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? '（token 无效或缺少 repo 权限）'
      : res.status === 422
        ? '（分支无差异，或同名 PR 已存在）'
        : '';
    throw new Error(`HTTP ${res.status}${hint} ${data.message || ''}`.trim());
  }
  return data.html_url;
}

export async function main(argv = process.argv.slice(2)) {
  const root = projectRoot(argValue(argv, '--root', process.cwd()));
  const stage = argValue(argv, '--stage', null);
  const base = argValue(argv, '--base', 'main');
  const kind = argValue(argv, '--bump', 'patch');
  const dryRun = hasFlag(argv, '--dry-run');
  const noPr = hasFlag(argv, '--no-pr');
  if (!stage) throw new Error('必须指定 --stage <req|plan|implement|test|review|debug>');
  if (!['patch', 'minor', 'major'].includes(kind)) {
    throw new Error(`--bump 只支持 patch|minor|major，收到：${kind}`);
  }

  const cwdIsPlugin = existsSync(join(process.cwd(), '.claude-plugin', 'plugin.json'));
  const pluginRoot = argValue(argv, '--plugin-root', null)
    || (cwdIsPlugin ? process.cwd() : resolveUpstreamRoot(root));

  if (isPluginCache(pluginRoot)) throw new Error(cacheGuardMessage(pluginRoot));

  const top = git(pluginRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    throw new Error(
      `插件目录不是 git 仓库：${posix(pluginRoot)}。\n`
      + '回灌并提交只能在插件源码仓库中执行；已安装的插件缓存无法提 PR。\n'
      + '请用 --plugin-root 指向源码仓库，或运行 /devflow:init --source-root <源码仓库> 记录一次。',
    );
  }
  if (!samePath(top.stdout.trim(), pluginRoot)) {
    throw new Error(`--plugin-root 必须是 git 仓库根目录：${top.stdout.trim()}`);
  }

  const remoteUrl = gitOut(pluginRoot, ['remote', 'get-url', 'origin']);
  const ghRepo = githubRemote(remoteUrl);

  const baseline = dirty(pluginRoot);
  const conflicts = baseline.filter((f) => isWhitelisted(f.path));

  const info = pluginInfo(pluginRoot);
  const oldVersion = info.version;
  const branch = uniqueBranch(pluginRoot, `devflow/upstream-${stage}-${stamp()}`);

  if (dryRun) {
    const result = await upstream(['--root', root, '--stage', stage, '--plugin-root', pluginRoot, '--bump', kind]);
    console.log('\n[dry-run] 不会创建分支或提交。');
    console.log(`将创建分支：${branch}（基于 ${base}）`);
    console.log(`将提交白名单文件：${result.pending} 个有变化的可回灌文件 + 版本与 CHANGELOG`);
    console.log(`插件版本：${oldVersion} → ${bumpVersion(oldVersion, kind)}`);
    if (conflicts.length) {
      console.log(`\n警告：以下回灌相关文件未提交，实际执行会被拒绝：${conflicts.map((f) => f.path).join('、')}`);
    }
    if (baseline.length) {
      console.log(`注意：工作区已有 ${baseline.length} 个改动不会被包含：${baseline.map((f) => f.path).join('、')}`);
    }
    return { stage, branch, applied: false };
  }

  if (conflicts.length) {
    throw new Error(
      `插件仓库有未提交的回灌相关改动，请先提交或 stash：${conflicts.map((f) => f.path).join('、')}`,
    );
  }

  // 先确认基分支存在，避免回灌写入后才发现无法建分支，留下脏工作区。
  const baseRef = [base, `origin/${base}`].find((ref) =>
    git(pluginRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0);
  if (!baseRef) {
    throw new Error(`找不到 --base ${base} 的本地或 origin 分支；请先 fetch，或改用正确的基础分支。`);
  }

  const result = await upstream(['--root', root, '--stage', stage, '--plugin-root', pluginRoot, '--apply', '--bump', kind]);
  if (!result.pending) {
    console.log('没有可回灌的变化，未创建分支。');
    return { stage, branch: null, applied: false };
  }

  const newVersion = result.version;
  const after = dirty(pluginRoot);
  const baselinePaths = new Set(baseline.map((f) => f.path));
  const outOfScope = after.filter((f) => !isWhitelisted(f.path) && !baselinePaths.has(f.path));
  if (outOfScope.length) {
    const reverted = [];
    for (const f of outOfScope) {
      try {
        if (f.status === '??' || f.status[0] === 'A') {
          rmSync(join(pluginRoot, f.path), { force: true });
          reverted.push(`删除 ${f.path}`);
        } else {
          gitOut(pluginRoot, ['checkout', '--', f.path]);
          reverted.push(`还原 ${f.path}`);
        }
      } catch { /* 尽力还原，失败不阻断报错 */ }
    }
    throw new Error(
      `回灌改动了白名单外的文件，已停止提交：${outOfScope.map((f) => f.path).join('、')}`
      + (reverted.length ? `\n已尝试还原：${reverted.join('、')}` : ''),
    );
  }

  const toAdd = after.filter((f) => isWhitelisted(f.path)).map((f) => f.path);
  if (!toAdd.length) throw new Error('没有可提交的改动');

  const originalBranch = gitOut(pluginRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  gitOut(pluginRoot, ['checkout', '-b', branch, baseRef]);
  for (const path of toAdd) gitOut(pluginRoot, ['add', '--', path]);

  const projectName = basename(root);
  const subject = `feat(templates): 回灌 ${stage} 阶段规则`;
  const message = [
    subject,
    '',
    `来源：${projectName}`,
    `文件：${toAdd.join('、')}`,
    `版本：${oldVersion} → ${newVersion}`,
  ].join('\n');
  gitOut(pluginRoot, ['commit', '-m', message]);
  log('ok', `已提交到分支 ${branch}`);

  const pushed = git(pluginRoot, ['push', '-u', 'origin', branch]);
  if (pushed.status !== 0) {
    // 保留分支与提交，但把工作区切回原分支，避免把用户留在半成品状态
    if (originalBranch && originalBranch !== 'HEAD') {
      git(pluginRoot, ['checkout', originalBranch]);
    }
    throw new Error(
      `push 失败，分支和提交已保留在本地：${branch}（已切回 ${originalBranch || '原分支'}）\n${(pushed.stderr || '').trim()}`,
    );
  }
  log('ok', `已推送到 origin/${branch}`);

  if (baseline.length) {
    console.log(`提醒：${baseline.length} 个工作区改动未包含在本次提交：${baseline.map((f) => f.path).join('、')}`);
  }

  if (noPr || !ghRepo) {
    if (!ghRepo) console.log(`远端不是 GitHub，无法生成 PR 链接：${redactUrl(remoteUrl)}`);
    return { stage, branch, applied: true, version: newVersion, prUrl: null };
  }

  const url = compareUrl(ghRepo.owner, ghRepo.repo, base, branch);
  const prBody = buildPrBody(pluginRoot, {
    stage, projectName, files: toAdd, oldVersion, newVersion, kind,
  });

  const ghAvailable = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
  if (ghAvailable) {
    const created = spawnSync('gh', [
      'pr', 'create', '--base', base, '--head', branch, '--title', subject, '--body', prBody,
    ], { cwd: pluginRoot, encoding: 'utf8' });
    if (created.status === 0) {
      const prUrl = (created.stdout || '').trim().split('\n').pop();
      log('ok', `已创建 PR：${prUrl}`);
      return { stage, branch, applied: true, version: newVersion, prUrl };
    }
    console.error(`[WARN] gh pr create 失败：${(created.stderr || '').trim()}`);
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    try {
      const prUrl = await createPrViaApi(ghRepo.owner, ghRepo.repo, base, branch, subject, prBody, token);
      log('ok', `已创建 PR（API）：${prUrl}`);
      return { stage, branch, applied: true, version: newVersion, prUrl };
    } catch (err) {
      console.error(`[WARN] GitHub API 创建 PR 失败：${err.message}`);
    }
  }

  console.log(`\n已推送分支，请打开以下链接创建 PR：\n${url}`);
  return { stage, branch, applied: true, version: newVersion, prUrl: url };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
