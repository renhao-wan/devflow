---
description: 实现阶段：按 plan.md 小步实现，测试先行，保持每步可运行
argument-hint: <slug> [任务编号]
allowed-tools: Read, Write, Edit, Glob, Grep, Skill, Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(node:*), Bash(npx:*), Bash(npm:*), Bash(pnpm:*), Bash(yarn:*), Bash(bun:*), Bash(mvn:*), Bash(gradle:*), Bash(./gradlew:*), Bash(gradlew.bat:*), Bash(go:*), Bash(cargo:*), Bash(dotnet:*), Bash(make:*), Bash(python:*), Bash(python3:*), Bash(pytest:*)
---

执行 devflow 实现阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/implement/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/implement/SKILL.md`；不存在时提示先运行 `/devflow:init`。
2. 完整读取 `docs/devflow/<slug>/plan.md` 与 `req.md`。计划缺失时先回到 `/devflow:plan`。
3. 按任务顺序推进，一次一个任务：
   - 能写测试的，先写失败测试并确认失败原因，再写最小实现；方法可用 `devflow-tdd` 技能，已安装 superpowers 时也可用其 TDD 技能，门禁仍以本阶段为准。
   - 不夹带无关改动，不顺手重构。
4. 每个任务完成后运行该子项目的测试命令（`hub.yaml` 中的 `testCommand`，否则 `defaults.testCommand`）。
5. 计划与实际偏离时，先更新 `plan.md` 再继续。
6. 结束时报告：已完成任务、未完成任务及原因、新增/修改的测试、运行过的验证命令与真实结果。没有运行的不要说已通过。
