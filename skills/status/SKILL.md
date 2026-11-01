---
name: status
description: 查看当前工作流进度、各任务产物缺口与建议的下一步命令
argument-hint: [--slug <slug>] [--json]
allowed-tools: Bash(node:*), Bash(devflow:*), Read, Glob, Grep
---

查看当前 devflow 进度。只读操作，不写任何状态。

1. 运行只读脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-status.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

`CLAUDE_PLUGIN_ROOT` 未设置时，改用 `devflow status $ARGUMENTS`。

2. 需要按任务过滤时加 `--slug <slug>`。只有一个任务时脚本会自动采用它；存在多个任务时不会替你选择。
3. 报告每个任务的已有产物、缺口、所处阶段与建议的下一步命令；轻量任务会标出「轻量功能 / 轻量修复」，并说明是否因 `review: required` 需要补审查。有测试待验证或投影待生成时一并说明。
4. 不要根据状态自行跳到下一阶段。状态只是建议，门禁仍以 `.claude/hub/stages/<stage>/SKILL.md` 为准。
