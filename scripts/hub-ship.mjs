#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, projectRoot,
  readText, log, posix, isMain, resolveUpstreamRoot, isPluginCache, cacheGuardMessage,
  samePath, isValidStageName, loadHub,
  warnUnknownArgs,
} from './lib/common.mjs';
import { isValidStackName } from './lib/stacks.mjs';
import {
  resolveUnits, planUnits, applyPlan, validateWrittenFiles, appendLog,
} from './lib/upstream.mjs';

const UPSTREAM_WHITELIST = [
  (p) => p === '.claude-plugin/plugin.json',
  (p) => p === '.claude-plugin/marketplace.json',
  (p) => p === 'package.json',
  (p) => p === 'CHANGELOG.md',
  (p) => p === '.devflow/upstream-log.jsonl',
  (p) => p === 'docs/upstream-log.md',
  (p) => p === 'templates/stages/_feedback-log.md',
  (p) => p.startsWith('templates/stages/'),
  (p) => p.startsWith('templates/shared/'),
  (p) => p.startsWith('templates/stacks/'),
];

// 团队模板库只提交模板与回灌日志，不碰版本文件与 CHANGELOG。
const TEAM_WHITELIST = [
  (p) => p === '.devflow/upstream-log.jsonl',
  (p) => p === 'docs/upstream-log.md',
  (p) => p.startsWith('templates/stages/'),
  (p) => p.startsWith('templates/shared/'),
  (p) => p.startsWith('templates/stacks/'),
];

function isWhitelisted(path, profile = 'upstream') {
  const p = path.replace(/\\/g, '/');
  const rules = profile === 'team' ? TEAM_WHITELIST : UPSTREAM_WHITELIST;
  return rules.some((match) => match(p));
}

function argValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
}

/** 日志与错误信息里去掉 URL 凭据、查询参数与常见 token，避免把密钥带进终端或日志。 */
export function redactText(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1$2:***@')
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, '$1***@')
    .replace(/([?&](?:token|access_token|api[_-]?key|key|secret|password|passwd|pwd|signature|x-amz-signature)=)[^&\s"']+/gi, '$1***');
}

function git(cwd, args, extra = []) {
  return spawnSync('git', [...args, ...extra], { cwd, encoding: 'utf8' });
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${redactText((r.stderr || r.stdout || '').trim())}`);
  }
  return r.stdout.trim();
}

function dirty(cwd) {
  // -uall 展开未跟踪目录：否则 git 只给 `.devflow/`、`docs/`，白名单无法匹配到具体文件。
  const r = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.status !== 0) {
    throw new Error(`git status 失败：${redactText((r.stderr || '').trim())}`);
  }
  const entries = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    out.push({ status, path: entry.slice(3).replace(/\\/g, '/') });
    if (status[0] === 'R' || status[0] === 'C') {
      if (status[0] === 'R' && entries[i + 1]) {
        out.push({ status, path: entries[i + 1].replace(/\\/g, '/') });
      }
      i += 1;
    }
  }
  return out;
}

function githubRemote(url) {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function uniqueBranch(cwd, base, remoteName = 'origin') {
  let name = base;
  let i = 2;
  for (;;) {
    const local = git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
    const remote = git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/${remoteName}/${name}`]).status === 0;
    if (!local && !remote) return name;
    name = `${base}-${i}`;
    i += 1;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** 临时 worktree 放在插件仓库同级的父目录，保证同一盘符，结束后删除。 */
function worktreePath(pluginRoot) {
  const parent = dirname(pluginRoot);
  const prefix = join(parent, `.devflow-ship-${basename(pluginRoot)}-${process.pid}-${stamp()}`);
  let candidate = prefix;
  let i = 2;
  while (existsSync(candidate)) {
    candidate = `${prefix}-${i}`;
    i += 1;
  }
  return candidate;
}

function removeWorktree(pluginRoot, dir) {
  try { git(pluginRoot, ['worktree', 'remove', '--force', dir]); } catch { /* fallback below */ }
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch { /* 尽力清理，不掩盖主流程错误 */ }
  try { git(pluginRoot, ['worktree', 'prune']); } catch { /* ignore */ }
}

function compareUrl(prRepo, base, headOwner, branch) {
  const head = headOwner ? `${headOwner}:${branch}` : branch;
  return `https://github.com/${prRepo.owner}/${prRepo.repo}/compare/${base}...${head}?expand=1`;
}

function unitNames(units) {
  return units.map((u) => {
    if (u.kind === 'shared') return '共享规则';
    if (u.kind === 'stack') return `${u.name} 技术栈`;
    return `${u.name} 阶段`;
  });
}

function unitRelPath(unit, rel) {
  if (unit.kind === 'shared') return `shared/${rel}`;
  if (unit.kind === 'stack') return `stacks/${unit.name}/${rel}`;
  return `${unit.name}/${rel}`;
}

/** 复用仓库 PR 模板，没有模板时退回内置结构。 */
export function buildSubject({ resume = false, units = [], all = false, slug = '' } = {}) {
  if (resume) return `feat(templates): 续做回灌 ${slug}`;
  if (units.length === 1) {
    const unit = units[0];
    if (unit.kind === 'stage') return `feat(templates): 回灌 ${unit.name} 阶段规则`;
    if (unit.kind === 'shared') return 'feat(templates): 回灌共享规则';
    if (unit.kind === 'stack') return `feat(templates): 回灌 ${unit.name} 技术栈规范`;
  }
  if (all) return 'feat(templates): 回灌全部阶段与技术栈规则';
  return `feat(templates): 回灌 ${slug} 规则`;
}

export function buildPrBody(pluginRoot, {
  stage, stages, stacks, shared, all, projectName, files,
}) {
  const names = [];
  if (all) names.push('所有阶段与技术栈');
  else {
    for (const name of [...(stages || []), ...(stage ? [stage] : [])]) names.push(`${name} 阶段`);
    for (const name of stacks || []) names.push(`${name} 技术栈`);
  }
  if (shared) names.push('共享规则');
  const unitText = names.join('、') || '阶段规则';
  const tplFile = join(pluginRoot, '.github', 'pull_request_template.md');
  const sections = {
    '变更内容': `## 变更内容\n\n回灌${unitText}，来源项目：${projectName}。`,
    '类型': '## 类型\n\n- [x] feat',
    '关联': `## 关联\n\n- 范围：${unitText}`,
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
      `- 兼容性：仅模板变更，不涉及插件版本`,
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

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'devflow-ship',
    'Content-Type': 'application/json',
  };
}

function apiHint(status) {
  if (status === 401 || status === 403) return '（token 无效或缺少 repo 权限）';
  if (status === 422) return '（分支无差异，或同名 PR 已存在）';
  return '';
}

/** 先查同 head 的开启中 PR：存在则更新标题与正文，不再重复创建。 */
async function upsertPrViaApi(prRepo, { base, head, headOwner, title, body, token }) {
  const headers = apiHeaders(token);
  const listUrl = `https://api.github.com/repos/${prRepo.owner}/${prRepo.repo}/pulls`
    + `?state=open&head=${encodeURIComponent(`${headOwner}:${head}`)}`;
  const listed = await fetch(listUrl, { headers });
  if (listed.ok) {
    const pulls = await listed.json().catch(() => []);
    const existing = Array.isArray(pulls) ? pulls.find((pr) => pr.head?.ref === head) : null;
    if (existing) {
      const res = await fetch(`https://api.github.com/repos/${prRepo.owner}/${prRepo.repo}/pulls/${existing.number}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}${apiHint(res.status)} ${data.message || ''}`.trim());
      return data.html_url || existing.html_url;
    }
  }

  const res = await fetch(`https://api.github.com/repos/${prRepo.owner}/${prRepo.repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, head: `${headOwner}:${head}`, base, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}${apiHint(res.status)} ${data.message || ''}`.trim());
  return data.html_url;
}

function ghUpsert(worktreeDir, { base, head, headOwner, title, body }) {
  const headArg = headOwner ? `${headOwner}:${head}` : head;
  const listed = spawnSync('gh', [
    'pr', 'list', '--head', headArg, '--state', 'open', '--json', 'url', '--jq', '.[0].url',
  ], { cwd: worktreeDir, encoding: 'utf8' });
  if (listed.status === 0) {
    const url = (listed.stdout || '').trim();
    if (url) {
      const edited = spawnSync('gh', ['pr', 'edit', url, '--title', title, '--body', body], {
        cwd: worktreeDir, encoding: 'utf8',
      });
      if (edited.status === 0) return { url, updated: true };
      return { error: (edited.stderr || '').trim() };
    }
  }
  const created = spawnSync('gh', [
    'pr', 'create', '--base', base, '--head', headArg, '--title', title, '--body', body,
  ], { cwd: worktreeDir, encoding: 'utf8' });
  if (created.status === 0) return { url: (created.stdout || '').trim().split('\n').pop() };
  return { error: (created.stderr || '').trim() };
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, [
    '--root', '--stage', '--stack', '--shared', '--all', '--profile', '--base',
    '--dry-run', '--no-pr', '--resume', '--remote', '--fork', '--plugin-root', '--pr-repo',
  ]);
  const root = projectRoot(argValue(argv, '--root', process.cwd()));
  const stages = argValues(argv, '--stage');
  const stacks = argValues(argv, '--stack');
  const shared = hasFlag(argv, '--shared');
  const all = hasFlag(argv, '--all');
  const profile = argValue(argv, '--profile', 'upstream');
  if (!['upstream', 'team'].includes(profile)) {
    throw new Error(`--profile 只支持 upstream|team，收到：${profile}`);
  }
  const { config } = loadHub(root);
  const teamConfig = config?.templates?.team || {};
  const base = argValue(argv, '--base', profile === 'team' ? (teamConfig.base || 'main') : 'main');
  const dryRun = hasFlag(argv, '--dry-run');
  const noPr = hasFlag(argv, '--no-pr');
  const resume = argValue(argv, '--resume', null);
  const remoteName = argValue(argv, '--remote', 'origin');
  const fork = hasFlag(argv, '--fork') || remoteName !== 'origin';

  if (!stages.length && !stacks.length && !shared && !all && !resume) {
    throw new Error('必须指定 --stage <name>、--stack <name>、--shared 或 --all');
  }
  for (const stage of stages) {
    if (!isValidStageName(stage)) {
      throw new Error(`阶段名非法：${stage}。只允许小写字母开头的 [a-z0-9_-]。`);
    }
  }
  for (const stack of stacks) {
    if (!isValidStackName(stack)) {
      throw new Error(`技术栈名非法：${stack}。只允许 [a-z0-9][a-z0-9_-]*。`);
    }
  }

  const cwdIsPlugin = existsSync(join(process.cwd(), '.claude-plugin', 'plugin.json'));
  const pluginRootArg = argValue(argv, '--plugin-root', null);
  if (profile === 'team' && !pluginRootArg) {
    throw new Error('团队模板库 PR 需要 --plugin-root <团队模板库根>。');
  }
  const pluginRoot = pluginRootArg
    || (cwdIsPlugin ? process.cwd() : resolveUpstreamRoot(root));

  if (isPluginCache(pluginRoot)) throw new Error(cacheGuardMessage(pluginRoot));

  const top = git(pluginRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    throw new Error(
      `${profile === 'team' ? '团队模板库' : '插件目录'}不是 git 仓库：${posix(pluginRoot)}。\n`
      + '回灌并提交只能在源码仓库中执行；已安装的插件缓存无法提 PR。\n'
      + '请用 --plugin-root 指向源码仓库，或运行 /devflow:init --source-root <源码仓库> 记录一次。',
    );
  }
  if (!samePath(top.stdout.trim(), pluginRoot)) {
    throw new Error(`--plugin-root 必须是 git 仓库根目录：${top.stdout.trim()}`);
  }

  const remoteUrl = git(pluginRoot, ['remote', 'get-url', remoteName]);
  if (remoteUrl.status !== 0) {
    throw new Error(`找不到 git remote ${remoteName}。请先添加远端，或改用 --remote <name>。`);
  }
  const remoteRepo = githubRemote(remoteUrl.stdout.trim());
  const pushRepo = remoteRepo;

  const prRepoArg = argValue(argv, '--pr-repo', null);
  let prRepo = pushRepo;
  if (prRepoArg) {
    const m = prRepoArg.match(/^([^/]+)\/([^/]+)$/);
    if (!m) throw new Error(`--pr-repo 需要 owner/repo 格式，收到：${prRepoArg}`);
    prRepo = { owner: m[1], repo: m[2] };
  }
  const headOwner = fork && pushRepo ? pushRepo.owner : null;
  const needsForkOwner = Boolean(headOwner && prRepo && headOwner !== prRepo.owner);

  const slug = (resume ? 'resume' : [...stages, ...stacks, ...(shared ? ['shared'] : []), ...(all ? ['all'] : [])].join('-'))
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-') || 'upstream';
  const branchPrefix = profile === 'team' ? 'team' : 'upstream';
  const branch = resume || uniqueBranch(pluginRoot, `devflow/${branchPrefix}-${slug}-${stamp()}`, remoteName);

  const baseline = dirty(pluginRoot);
  const conflicts = baseline.filter((f) => isWhitelisted(f.path, profile));

  if (resume) {
    // 只允许续做本工具创建的分支：--resume 不能变成推送任意分支的入口。
    const prefix = `devflow/${branchPrefix}-`;
    if (!String(resume).startsWith(prefix)) {
      throw new Error(`--resume 只接受本工具创建的分支（${prefix}*），收到：${resume}`);
    }
    const validRef = git(pluginRoot, ['check-ref-format', '--branch', resume]);
    if (validRef.status !== 0) throw new Error(`--resume 分支名非法：${resume}`);
    const exists = git(pluginRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${resume}`]).status === 0;
    if (!exists) throw new Error(`--resume 需要本地分支已存在：${resume}`);
  }

  const baseRef = [base, `origin/${base}`].find((ref) =>
    git(pluginRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0);
  if (!baseRef) {
    throw new Error(`找不到 --base ${base} 的本地或 origin 分支；请先 fetch，或改用正确的基础分支。`);
  }
  if (!resume && baseRef.startsWith('origin/')) {
    log('..', `使用 ${baseRef}（不会自动 fetch；如远端刚更新，请先 git fetch origin ${base}）`);
  }

  const units = resume ? [] : resolveUnits(root, {
    stages,
    stacks,
    shared,
    all,
    onSkip: (names) => log('warn', `跳过无法声明的技术栈目录：${names.join('、')}（只允许 [a-z0-9][a-z0-9_-]*）`),
  });
  const plans = resume ? [] : planUnits(root, pluginRoot, units, config);
  const pending = plans.flatMap((p) => p.pending);

  if (dryRun) {
    if (resume) {
      console.log(`[dry-run] 将推送已有分支 ${branch} 并创建/更新 PR。`);
    } else {
      for (const plan of plans) {
        for (const file of plan.files) {
          const rel = unitRelPath(plan.unit, file.rel);
          if (file.skipped) console.log(`[跳过] ${rel}（${file.reason}）`);
          else if (file.verdict.type === 'local') console.log(`[项目专属] ${rel}`);
          else console.log(`[${file.changed ? '可回灌' : '无变化'}] ${rel}`);
        }
      }
      console.log('\n[dry-run] 不会创建分支或提交。');
      console.log(`将创建分支：${branch}（基于 ${base}）`);
      console.log(`将提交 ${pending.length} 个有变化的可回灌文件（不改版本文件）`);
      console.log(`推送远端：${remoteName}${remoteRepo ? `（${remoteRepo.owner}/${remoteRepo.repo}）` : ''}`);
      if (needsForkOwner) console.log(`PR head：${headOwner}:${branch} → ${prRepo.owner}/${prRepo.repo}:${base}`);
    }
    if (conflicts.length) {
      console.log(`\n警告：以下回灌相关文件未提交，实际执行会被拒绝：${conflicts.map((f) => f.path).join('、')}`);
    }
    if (baseline.length) {
      console.log(`注意：工作区已有 ${baseline.length} 个改动不会被包含：${baseline.map((f) => f.path).join('、')}`);
    }
    return { stages, branch, applied: false };
  }

  if (conflicts.length) {
    throw new Error(
      `插件仓库有未提交的回灌相关改动，请先提交或 stash：${conflicts.map((f) => f.path).join('、')}`,
    );
  }

  const worktreeDir = worktreePath(pluginRoot);
  let worktreeAdded = false;
  let keepBranch = false;
  try {
    // 在临时 worktree 中回灌和提交：主工作区的改动、当前分支和未提交文件完全不受影响。
    if (resume) {
      gitOut(pluginRoot, ['worktree', 'add', worktreeDir, branch]);
    } else {
      gitOut(pluginRoot, ['worktree', 'add', '-b', branch, worktreeDir, baseRef]);
    }
    worktreeAdded = true;

    if (!resume) {
      // 必须基于临时 worktree 重算：它检出的是 baseRef，与主工作区当前模板可能不同。
      const worktreePlans = planUnits(root, worktreeDir, units, config);
      const worktreePending = worktreePlans.flatMap((p) => p.pending);
      if (!worktreePending.length) {
        console.log('没有可回灌的变化，未创建分支。');
        return { stages, branch: null, applied: false };
      }

      const result = applyPlan({ pending: worktreePending }, worktreeDir);
      const errors = validateWrittenFiles(worktreeDir, result.written);
      if (errors.length) {
        throw new Error(`回灌结果未通过提交前校验：\n- ${errors.join('\n- ')}`);
      }

      appendLog(worktreeDir, {
        id: `ship-${stamp()}`,
        at: new Date().toISOString(),
        mode: profile === 'team' ? 'team-pr' : 'remote',
        units: unitNames(units),
        project: basename(root),
        files: result.written,
        created: result.created,
        oldVersion: null,
        newVersion: null,
      });
    }

    const after = dirty(worktreeDir);
    const outOfScope = after.filter((f) => !isWhitelisted(f.path, profile));
    if (outOfScope.length) {
      throw new Error(`回灌改动了白名单外的文件，已停止提交：${outOfScope.map((f) => f.path).join('、')}`);
    }

    const toAdd = after.filter((f) => isWhitelisted(f.path, profile)).map((f) => f.path);
    if (!toAdd.length) {
      if (resume) {
        log('..', `分支 ${branch} 没有新的白名单改动，直接推送。`);
      } else {
        throw new Error('没有可提交的改动');
      }
    } else {
      for (const path of toAdd) gitOut(worktreeDir, ['add', '--', path]);
    }

    const projectName = basename(root);
    const subject = buildSubject({ resume, units, all, slug });
    if (toAdd.length) {
      const message = [
        subject,
        '',
        `来源：${projectName}`,
        `文件：${toAdd.join('、')}`,
      ].join('\n');
      gitOut(worktreeDir, ['commit', '-m', message]);
      log('ok', `已提交到分支 ${branch}`);
    }
    keepBranch = true;

    const pushed = git(worktreeDir, ['push', '-u', remoteName, branch]);
    if (pushed.status !== 0) {
      throw new Error(
        `push 失败，分支和提交已保留在本地：${branch}，主工作区未切换。\n${redactText((pushed.stderr || '').trim())}`,
      );
    }
    log('ok', `已推送到 ${remoteName}/${branch}`);

    if (baseline.length) {
      console.log(`提醒：${baseline.length} 个工作区改动未包含在本次提交：${baseline.map((f) => f.path).join('、')}`);
    }

    if (noPr || !prRepo) {
      if (!prRepo) console.log(`远端不是 GitHub，无法生成 PR 链接：${redactText(remoteUrl.stdout.trim())}`);
      return { stages, branch, applied: true, prUrl: null };
    }

    const url = compareUrl(prRepo, base, needsForkOwner ? headOwner : null, branch);
    const prBody = buildPrBody(worktreeDir, {
      stages,
      stacks,
      shared: units.some((u) => u.kind === 'shared'),
      all,
      projectName,
      files: toAdd.length ? toAdd : ['（续做，无新增文件）'],
    });

    const ghAvailable = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
    if (ghAvailable) {
      const result = ghUpsert(worktreeDir, {
        base, head: branch, headOwner: needsForkOwner ? headOwner : null, title: subject, body: prBody,
      });
      if (result.url) {
        log('ok', `${result.updated ? '已更新' : '已创建'} PR：${result.url}`);
        return { stages, branch, applied: true, prUrl: result.url };
      }
      console.error(`[WARN] gh pr 操作失败：${redactText(result.error || '')}`);
    }

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      try {
        const prUrl = await upsertPrViaApi(prRepo, {
          base,
          head: branch,
          headOwner: needsForkOwner ? headOwner : prRepo.owner,
          title: subject,
          body: prBody,
          token,
        });
        log('ok', `已创建或更新 PR（API）：${prUrl}`);
        return { stages, branch, applied: true, prUrl };
      } catch (err) {
        console.error(`[WARN] GitHub API 操作 PR 失败：${err.message}`);
      }
    }

    console.log(`\n已推送分支，请打开以下链接创建 PR：\n${url}`);
    return { stages, branch, applied: true, prUrl: url };
  } finally {
    if (worktreeAdded) removeWorktree(pluginRoot, worktreeDir);
    // 没有提交时删除刚创建的空分支；已提交（含 push 失败）则保留，便于用户续推。
    if (worktreeAdded && !keepBranch) git(pluginRoot, ['branch', '-D', branch]);
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
