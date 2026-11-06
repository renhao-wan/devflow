#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  argValue, hasFlag, isMain, log, projectRoot, posix,
  warnUnknownArgs,
} from './lib/common.mjs';
import { generateOverview, OVERVIEW_FILE } from './lib/overview.mjs';
import { assessProject } from './lib/assessment.mjs';

export function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, ['--root', '--print', '--json', '--now']);
  const root = resolve(argValue(argv, '--root', projectRoot()));
  const print = hasFlag(argv, '--print');
  const json = hasFlag(argv, '--json');
  if (print && json) throw new Error('--print 与 --json 不能同时使用');
  let isDir = false;
  try { isDir = existsSync(root) && statSync(root).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new Error(`工作区不存在或不是目录：${posix(root)}`);
  const nowRaw = argValue(argv, '--now', null);
  // --now 会直接写进自动段注释：只接受单行短字符串，避免注入额外 Markdown。
  if (nowRaw !== null && !/^[^\r\n]{1,80}$/.test(nowRaw)) {
    throw new Error('--now 需要单行文本（最多 80 字符）');
  }
  const now = nowRaw ?? new Date().toISOString();
  const result = generateOverview(root, { full: true, now, write: !print });

  if (print) {
    console.log(result.content);
    return result;
  }
  // 适用性参考是附加信息：扫描失败不应让已完成的概览更新表现为失败。
  let assessment = null;
  try {
    assessment = assessProject({
      root,
      facts: result.facts,
      // 与摘要共用同一份子项目来源，避免两个数字互相矛盾；
      // 测试信号仍由 assessProject 重新探测，不使用 hub.yaml 的兜底命令。
      subprojects: result.subprojects,
    });
  } catch {
    // 降级处理；错误信息不回显，避免带出不可读路径。
  }
  if (json) {
    if (!assessment) console.error('[WARN] 适用性参考不可用，已跳过（不影响概览）');
    console.log(JSON.stringify({
      file: posix(join(root, OVERVIEW_FILE)),
      changed: result.changed,
      subprojects: result.subprojects,
      facts: result.facts,
      assessment,
    }, null, 2));
    return result;
  }
  const summary = `${result.facts.techStack.length} 项技术栈、${result.subprojects.length} 个子项目、`
    + `${result.facts.entrypoints.length} 个入口、${result.facts.ci.length} 个 CI`;
  log(result.changed ? 'ok' : '..', result.changed
    ? `已更新 ${OVERVIEW_FILE}（${summary}）`
    : `${OVERVIEW_FILE} 无变化（${summary}）`);
  if (assessment) {
    log('info', `适用性参考：${assessment.label}（${assessment.reasons.join('；')}）`);
    log('info', assessment.suggestion);
    log('info', assessment.disclaimer);
  } else {
    log('warn', '适用性参考不可用，已跳过（不影响概览）');
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  }
}
