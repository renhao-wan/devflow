---
name: devflow-hub-management
description: Use when editing devflow hub config, stage templates, subproject mappings, generated projections, or when doctor reports drift. Explains the single-source-of-truth rules.
---

# Hub 管理

## 目录职责

| 路径 | 作用 | 是否手改 |
| --- | --- | --- |
| `.claude/hub/hub.yaml` | 阶段、子项目、测试命令、回灌规则 | 可以 |
| `.claude/hub/stages/<stage>/SKILL.md` | 阶段规则的单一真源 | 可以 |
| `.claude/hub/stages/<stage>/references/` | 阶段细则，按需读取 | 可以 |
| `.claude/hub/stages/<stage>/templates/` | 产出骨架 | 可以 |
| `.claude/hub/overrides/<sub>/<stage>.md` | 子项目级覆盖 | 可以 |
| `.claude/skills/devflow-<stage>/SKILL.md` | 生成的投影 | 不要 |
| `.claude/.hub-manifest.json` | 生成账本（哈希） | 不要 |
| `.devflow.json` | 插件位置与版本 | 不要 |

## 改规则的正确流程

1. 编辑 `.claude/hub/stages/<stage>/SKILL.md`，需要补充细则或产出骨架时，在阶段目录下增删 `references/`、`templates/`。
2. 运行 `node scripts/devflow-gen.mjs`（资源清单会进入投影与账本）。
3. 运行 `node scripts/devflow-doctor.mjs` 确认无漂移、资源未缺失。

## hub.yaml 要点

- `requiresPlugin`：语义化版本范围，插件不满足时生成器会拒绝。
- `stages`：声明哪些阶段启用；顺序即流程顺序。
- `subprojects`：多根工作区映射；每个可声明 `path`、`stages`、`testCommand`。
- `defaults.testCommand`：没有子项目级命令时使用。
- `upstream.blocklist`：回灌时识别项目专属内容的关键词。

## 多根工作区

- 只从项目根启动；子项目不单独初始化 hub。
- 共享规则放在根 hub；子项目差异放进 `overrides/`。
- 测试命令按子项目声明，避免在根目录跑错命令。

## 漂移处理

`/devflow:doctor` 报告「投影被手改或过期」时：

- 如果改动是有意的 → 改源文件，而不是改投影。
- 如果改动是误操作 → 重新生成覆盖。

不要直接编辑 `.claude/skills/devflow-*`。

## 回灌

`/devflow:upstream --stage <stage>` 默认只预览。`--apply` 才会写插件模板、bump patch 版本。阶段目录下的 `references/`、`templates/` 会递归处理并保留相对路径。项目专属内容（绝对路径、内网地址、子项目名、blocklist 命中）不会回灌。

## 版本升级

`hub.yaml` 的 `requiresPlugin` 决定兼容范围。升级插件后先运行 doctor；不满足时要么升级 hub 配置，要么回退插件版本。
