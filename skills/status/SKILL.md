---
name: status
description: 查看当前工作流进度、各任务产物缺口与建议的下一步命令
argument-hint: [--slug <slug>] [--json] [--ack]
allowed-tools: Bash(node:*), Bash(devflow:*), Read, Glob, Grep
---

查看当前 devflow 进度。只读操作，不写任何状态。

1. 运行只读脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-status.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

`CLAUDE_PLUGIN_ROOT` 未设置时，改用 `devflow status $ARGUMENTS`。

2. 需要按任务过滤时加 `--slug <slug>`。只有一个任务时脚本会自动采用它；存在多个任务时不会替你选择。
3. 报告每个任务的已有产物、缺口、所处阶段与建议的下一步命令；轻量任务会标出「轻量功能 / 轻量修复」，并说明 triage 的触发结果（`review: required`、风险信号、已跳过或快照可能过期）以及是否需要补审查。有测试待验证或投影待生成时一并说明。提示下游可能过期时，报告具体产物、推荐的归档起点和预览命令（不带 `--apply`）；是否执行由用户确认，不要自动归档。用户确认是误报（如 `git checkout`、复制文件）时，可运行 `devflow status --slug <slug> --ack` 记录指纹；它不移动产物，任一产物再变化会重新提示，多任务时必须显式指定 slug。
4. 不要根据状态自行跳到下一阶段。状态只是建议，门禁仍以 `.claude/hub/stages/<stage>/SKILL.md` 为准。
