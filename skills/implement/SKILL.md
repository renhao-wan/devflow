---
name: implement
description: 实现阶段：按 plan.md 小步实现，测试先行，保持每步可运行
argument-hint: <slug> [任务编号] [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, Skill, Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(node:*), Bash(devflow:*), Bash(npx:*), Bash(npm:*), Bash(pnpm:*), Bash(yarn:*), Bash(bun:*), Bash(mvn:*), Bash(gradle:*), Bash(./gradlew:*), Bash(gradlew.bat:*), Bash(go:*), Bash(cargo:*), Bash(dotnet:*), Bash(make:*), Bash(python:*), Bash(python3:*), Bash(pytest:*)
---

执行 devflow 实现阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/implement/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/implement/SKILL.md`；不存在时提示先运行 `/devflow:init`。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage implement <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage implement <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:test-driven-development`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/plan.md` 与 `docs/devflow/*/brief.md`，按 slug 去重：只有一个候选就采用；多个时列出候选让用户选择，不要自行挑选，也不要用 `latest` 代替；没有候选时提示先运行 `/devflow:req`（小改动加 `--light`）。目录有 `req.md` 却缺 `plan.md` 时，提示先运行 `/devflow:plan <slug>`，不得用 `brief.md` 或实现阶段代替计划。
3. 完整读取 `docs/devflow/<slug>/plan.md` 与 `req.md`；轻量功能改读 `brief.md`（含验收标准与测试计划）。计划缺失时先回到 `/devflow:plan`（轻量功能回到 `/devflow:req --light`）。
4. 按任务顺序推进，一次一个任务：
   - 能写测试的，先写失败测试并确认失败原因，再写最小实现；方法可用 `devflow-tdd` 技能，已安装 superpowers 时也可用其 TDD 技能，门禁仍以本阶段为准。
   - 不夹带无关改动，不顺手重构。
5. 每个任务完成后运行该子项目的测试命令（`hub.yaml` 中的 `testCommand`，否则 `defaults.testCommand`）。
6. 计划与实际偏离时，先更新 `plan.md`（轻量功能更新 `brief.md` 的「实施记录」）再继续；轻量功能命中硬触发（非测试/文档改动超过 200 行、10 个文件或 2 个子项目，或涉及依赖、公共接口/契约、数据结构/迁移、权限/认证/支付/并发/安全边界、不可逆操作）时，停止轻量流程并升级完整流程；完整任务范围明显扩大时说明并更新 `plan.md`。计数口径：`git diff --numstat`（staged + unstaged），排除 `docs/devflow/**`、测试文件、lockfile 与生成物。
7. 结束时报告：已完成任务、未完成任务及原因、新增/修改的测试、运行过的验证命令与真实结果。没有运行的不要说已通过。
8. 实现完成且自测通过后进入测试阶段：`/devflow:test <slug>`。
