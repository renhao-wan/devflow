import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isPathInside, isRealPathInside } from './common.mjs';
import { detectTestCommand, discoverSubprojects } from './discover.mjs';

/** 静态启发式不读取 hub.yaml：init 在探测不到测试命令时也会写 npm test，
 * 把配置里的 testCommand 当作“有测试”的证据会把兜底值误判成真实信号。 */
function hasOwnTestCommand(root, dirs) {
  if (detectTestCommand(root)) return true;
  return dirs.some((dir) => detectTestCommand(dir, root));
}

function safeSubprojectDirs(root, subprojects) {
  const dirs = [];
  for (const sub of subprojects) {
    const rel = typeof sub?.path === 'string' ? sub.path : null;
    if (!rel) continue;
    const dir = resolve(root, rel);
    // 声明的子项目路径可能被改成 ../ 或 junction，只统计仍在项目内的真实目录。
    if (!isPathInside(root, dir) || !isRealPathInside(root, dir)) continue;
    dirs.push(dir);
  }
  return dirs;
}

/**
 * 项目画像：只基于可解释的静态信号给出参考，不判断项目是否适合 devflow。
 * 返回的 level 只控制“更接近完整流程/轻量流程”的措辞，调用方不应把它当作硬性结论。
 */
export function assessProject({ root, facts = {}, subprojects = null } = {}) {
  const subs = Array.isArray(subprojects) ? subprojects : discoverSubprojects(root).list;
  const dirs = safeSubprojectDirs(root, subs);
  const ciCount = Array.isArray(facts.ci) ? facts.ci.length : 0;
  const signals = {
    git: existsSync(join(root, '.git')),
    tests: hasOwnTestCommand(root, dirs),
    ci: ciCount > 0,
    multiProject: dirs.length >= 2,
  };
  const strongSignals = Object.values(signals).filter(Boolean).length;

  let level;
  if (strongSignals >= 3) level = 'full';
  else if (strongSignals === 0) level = 'light';
  else level = 'unclear';

  const label = {
    full: '更接近完整流程',
    light: '更接近轻量流程',
    unclear: '信息不足',
  }[level];
  const suggestion = {
    full: '完整任务走 /devflow:req；小功能仍可用 /devflow:req --light。',
    light: '先用 /devflow:req --light；需要方案评审或评审留痕时再升级。',
    unclear: '按单个任务的规模选择：小功能用 --light，小 bug 用 /devflow:debug，需要评审时走完整流程。',
  }[level];
  const reasons = [
    signals.git ? '位于 Git 仓库' : '未检测到 Git 仓库',
    signals.tests ? '检测到可直接运行的测试命令' : '未检测到可直接运行的测试命令',
    signals.ci ? `检测到 ${ciCount} 个 GitHub Actions 工作流` : '未检测到 GitHub Actions 工作流',
    signals.multiProject ? `包含 ${dirs.length} 个子项目` : '未识别到多个子项目',
  ];

  return {
    level,
    label,
    suggestion,
    strongSignals,
    signals,
    reasons,
    disclaimer: '仅为静态启发式参考，不构成是否使用 devflow 的结论；实际价值取决于项目是否长期维护、是否需要可追溯记录。',
  };
}
