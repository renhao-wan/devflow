---
description: 方案阶段：基于 req.md 产出技术方案、任务拆分与测试策略
argument-hint: <slug 或任务描述>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(node:*)
---

对以下需求执行 devflow 方案阶段：**$ARGUMENTS**

1. 读取 `.claude/hub/stages/plan/SKILL.md`；不存在时提示先运行 `/devflow:init`。
2. 找到并完整读取 `docs/devflow/<slug>/req.md`。缺失或门禁未过时，先回到 `/devflow:req`，不要凭空设计方案。
3. 阅读相关代码，确认真实入口、数据结构与依赖。
4. 按 SKILL 产出方案：推荐方案 + 被否方案及原因、任务拆分表、测试策略、回滚、风险。
5. 逐条对照需求验收标准，确认都能映射到任务或测试；不能映射的指出来。
6. 写入 `docs/devflow/<slug>/plan.md`，并报告任务数与最大风险。
