---
description: 方案阶段：基于 req.md 调研已有实现，产出技术方案、任务拆分与测试策略
argument-hint: <slug 或任务描述>
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Bash(gh:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(node:*)
---

对以下需求执行 devflow 方案阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/plan/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/plan/SKILL.md`；不存在时提示先运行 `/devflow:init`。
2. 找到并完整读取 `docs/devflow/<slug>/req.md`。缺失或门禁未过时，先回到 `/devflow:req`，不要凭空设计方案。
3. 阅读相关代码，确认真实入口、数据结构与依赖。
4. 按改动规模分级，决定方案深度；新增依赖、新子系统或架构性选择必须调研已有实现：
   - 用外部社区会用的词检索 GitHub、官方文档与开源项目；
   - 候选至少核对来源、许可证、维护状态与项目约束；
   - 搜索失败时按 SKILL 的「搜索失败协议」降级并留痕，不得把“没搜到”写成“没有”。
5. 按 SKILL 产出方案：推荐方案 + 候选取舍 + 被否方案及原因、任务拆分表、测试策略、回滚、风险。
6. 已有 superpowers `brainstorming` 结果或 `writing-plans` 计划时，把结论吸收进 `plan.md`，不并存两份设计/计划。
7. 逐条对照需求验收标准，确认都能映射到任务或测试；不能映射的指出来。
8. 写入 `docs/devflow/<slug>/plan.md`，并报告任务数、最大风险、复用结论与未验证项。
