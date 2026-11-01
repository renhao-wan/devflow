#!/usr/bin/env node
import {
  argValue, hasFlag, isMain, log, posix, projectRoot, isValidStageName, isRealPathInside,
} from './lib/common.mjs';
import {
  ECOSYSTEM_FILE, STATE_FILE,
  createDefaultConfig, decideRoute, ecosystemPath, isStale, loadEcosystem, loadState,
  statePath, summarizeState, validateConfig, writeDetectedState,
} from './lib/ecosystem.mjs';

function note(json, status, message) {
  if (json) process.stderr.write(`[${status}] ${message}\n`);
  else log(status, message);
}

function toolRows(config, state) {
  return Object.entries(config.tools).map(([id, tool]) => {
    const recorded = state?.tools?.[id] || {};
    return {
      id,
      label: tool.label || id,
      kind: tool.kind,
      enabled: tool.enabled !== false,
      stages: [...tool.stages],
      invoke: tool.invoke,
      available: recorded.available === true,
      signals: Array.isArray(recorded.signals) ? recorded.signals : [],
      note: tool.note,
    };
  });
}

function printList(root, config, state, configured) {
  console.log(`项目：${posix(root)}`);
  console.log(`路由模式：${config.routing.mode}${configured ? '' : '（未配置 ecosystem.yaml，使用默认值）'}`);
  const rows = toolRows(config, state);
  if (!rows.length) {
    console.log('未声明任何工具。');
    return;
  }
  console.log('工具：');
  for (const row of rows) {
    const flags = [
      row.kind,
      row.enabled ? null : '已禁用',
      row.available ? '已检测' : '未检测',
    ].filter(Boolean).join(' · ');
    console.log(`- ${row.id}（${row.label}）[${flags}]`);
    console.log(`  阶段：${row.stages.join(', ') || '未声明'}`);
    if (row.invoke) console.log(`  入口：${row.invoke}`);
    if (row.signals.length) console.log(`  信号：${row.signals.join(', ')}`);
  }
}

function printDecision(decision) {
  const tool = decision.tool;
  if (decision.decision === 'use-devflow') {
    console.log(`[路由] 使用 devflow：${decision.reason}`);
    return;
  }
  if (decision.decision === 'suggest') {
    console.log(`[路由] 建议 ${tool.label}：${decision.reason}`);
    if (tool.invoke) console.log(`       入口：${tool.invoke}`);
    if (tool.note) console.log(`       说明：${tool.note}`);
    if (decision.alternatives.length) {
      console.log(`       其他候选：${decision.alternatives.map((t) => t.label).join('、')}`);
    }
    console.log('       保持 devflow：加 --force-devflow；改用该工具：加 --tool <id>。');
    return;
  }
  console.log(`[路由] 使用 ${tool.label}：${decision.reason}`);
  if (tool.invoke) console.log(`       入口：${tool.invoke}`);
  console.log('       阶段门禁与 docs/devflow/<slug>/ 产物仍由 devflow 负责。');
}

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const detect = hasFlag(argv, '--detect');
  const list = hasFlag(argv, '--list');
  const stage = argValue(argv, '--stage', null);
  const toolId = argValue(argv, '--tool', null);
  // --no-route 与 --force-devflow 等价，便于阶段脚本统一传参。
  const forceDevflow = hasFlag(argv, '--force-devflow') || hasFlag(argv, '--no-route');
  const home = argValue(argv, '--home', null) || undefined;

  let eco = loadEcosystem(root);
  if (eco.error) {
    note(json, 'warn', `${ECOSYSTEM_FILE} 解析失败，已回退默认配置：${eco.error}`);
  }

  if (detect) {
    // 检测会写入项目；拒绝通过 junction/符号链接写到项目外。
    if (!isRealPathInside(root, ecosystemPath(root)) || !isRealPathInside(root, statePath(root))) {
      note(json, 'error', `拒绝写入：${ECOSYSTEM_FILE} 或 ${STATE_FILE} 的真实路径在项目外`);
      process.exitCode = 1;
      return;
    }
    if (!eco.exists) {
      createDefaultConfig(root);
      eco = loadEcosystem(root);
      note(json, 'ok', `创建 ${ECOSYSTEM_FILE}`);
    }
    const detected = writeDetectedState(root, eco.config, { home });
    const summary = summarizeState(detected, eco.config);
    // 单独的 --detect 输出检测报告；带 --stage 或 --list 时继续执行后者，避免 JSON 流混在一起。
    const detectOnly = !stage && !list;
    if (json && detectOnly) {
      console.log(JSON.stringify({
        root: posix(root),
        file: STATE_FILE,
        detectedAt: detected.detectedAt,
        available: summary.available,
        tools: detected.tools,
      }, null, 2));
      return;
    }
    if (!json) {
      note(json, 'ok', summary.available.length
        ? `检测完成：${summary.available.join('、')}（${STATE_FILE}）`
        : `检测完成：未发现已知工具（${STATE_FILE}）`);
    }
    if (detectOnly) return;
  }

  const { state, exists: stateExists, error: stateError } = loadState(root);
  if (stateError) note(json, 'warn', `${STATE_FILE} 损坏，按未检测处理：${stateError}`);
  let stale = isStale(state, eco.config.routing.detectMaxAgeDays);

  if (list) {
    if (json) {
      console.log(JSON.stringify({
        root: posix(root),
        configured: eco.exists,
        mode: eco.config.routing.mode,
        stale,
        detectedAt: state.detectedAt,
        tools: toolRows(eco.config, state),
      }, null, 2));
      return;
    }
    printList(root, eco.config, state, eco.exists);
    if (stale) note(json, 'warn', `检测结果已过期或缺失，运行 devflow route --detect 更新。`);
    return;
  }

  if (!stage) {
    note(json, 'error', '用法：devflow route --stage <req|plan|implement|test|review|debug> [--tool <id>] [--force-devflow] [--detect] [--list] [--json]');
    process.exitCode = 1;
    return;
  }
  if (!isValidStageName(stage)) {
    note(json, 'error', `非法阶段名：${stage}；只允许小写字母开头的 [a-z0-9_-]`);
    process.exitCode = 1;
    return;
  }

  // 未初始化生态索引时保守回退；显式指定工具时仍允许使用默认目录。
  let config = eco.config;
  // 检测结果被 gitignore：新克隆项目首次进入阶段、或结果过期时，懒加载一次。
  let activeState = state;
  if (eco.exists && !eco.error && (!stateExists || stale)
    && !forceDevflow && toolId !== 'devflow') {
    if (!isRealPathInside(root, statePath(root))) {
      note(json, 'warn', `拒绝自动写入 ${STATE_FILE}：真实路径在项目外`);
    } else {
      try {
        activeState = writeDetectedState(root, config, { home });
        stale = false;
        note(json, 'ok', `检测结果缺失或过期，已自动检测（${STATE_FILE}）`);
      } catch (err) {
        note(json, 'warn', `自动检测失败，按未检测处理：${err.message}`);
      }
    }
  }

  let decision;
  if (!eco.exists && !toolId && !forceDevflow) {
    decision = {
      stage,
      mode: config.routing.mode,
      decision: 'use-devflow',
      reason: `未配置 ${ECOSYSTEM_FILE}；使用 devflow`,
      tool: null,
      alternatives: [],
      constraints: { keepStageGates: true, keepArtifacts: true, autoAllowed: false },
    };
  } else {
    decision = decideRoute({
      config, state: activeState, stage, forceDevflow, toolId,
    });
  }

  if (decision.decision === 'error') {
    note(json, 'error', decision.reason);
    if (json) console.log(JSON.stringify({ root: posix(root), ...decision }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (stale) {
    note(json, 'warn', `检测结果已过期或缺失；准确度可能下降，运行 devflow route --detect 更新。`);
  }
  if (eco.raw) {
    const { errors, warnings } = validateConfig(eco.raw);
    for (const warning of warnings) note(json, 'warn', warning);
    for (const err of errors) note(json, 'warn', `${ECOSYSTEM_FILE}：${err}`);
  }
  for (const warning of decision.warnings || []) note(json, 'warn', warning);

  if (json) {
    console.log(JSON.stringify({ root: posix(root), ...decision }, null, 2));
    return;
  }
  printDecision(decision);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
