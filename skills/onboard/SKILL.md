---
name: onboard
description: 熟悉项目：扫描技术栈、目录、子项目、入口与 CI，生成 .claude/hub/project-overview.md
argument-hint: [--print] [--json]
allowed-tools: Bash(node:*), Bash(devflow:*), Read, Glob, Grep
disable-model-invocation: true
---

扫描当前项目并生成/更新项目概览。只读扫描，不修改业务代码。

1. 运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-onboard.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

`CLAUDE_PLUGIN_ROOT` 未设置时，改用 `devflow onboard $ARGUMENTS`。

2. 脚本只更新 `.claude/hub/project-overview.md` 中 `<!-- devflow:auto:start -->` 到 `<!-- devflow:auto:end -->` 的自动段；`## 项目补充` 等标记外内容保留，不覆盖手写内容。
3. 报告：识别到的技术栈、子项目数、入口文件数、CI 数量，以及需要人工确认的项。
4. 复述脚本输出的“适用性参考”：等级（更接近完整流程 / 更接近轻量流程 / 信息不足）、依据信号与建议。必须说明它只是基于 Git、可运行的测试工具链、GitHub Actions、子项目数量等静态信号的启发式参考，**不构成项目是否适合 devflow 的结论**；不要自行加码成确定判断。`--json` 中该信息在 `assessment` 字段；为 `null` 时表示评估扫描失败，如实说明即可，不要把它当成“信息不足”等级。
5. 不执行项目代码、不安装依赖；只读文件与目录。
6. 若 `.claude/hub/hub.yaml` 不存在，提示先运行 `/devflow:init`。
