---
name: plan
description: 方案阶段：基于 req.md 调研已有实现，产出技术方案、任务拆分与测试策略
argument-hint: <slug 或任务描述> [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Skill, Bash(gh:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(node:*), Bash(devflow:*)
---

对以下需求执行 devflow 方案阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/plan/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/plan/SKILL.md`；不存在时提示先运行 `/devflow:init`。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage plan <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage plan <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:brainstorming`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/req.md`：只有一个候选就采用；多个时列出候选让用户选择，不要自行挑选，也不要用 `latest` 代替。没有 `req.md` 时，说明完整方案阶段需要 `req.md`：若目录只有 `brief.md`，提示直接 `/devflow:implement <slug>`（轻量功能）；若都没有，提示先运行 `/devflow:req`（小改动加 `--light`）。
3. 找到并完整读取 `docs/devflow/<slug>/req.md`。缺失时：若目录只有 `brief.md`，说明这是轻量功能，提示直接 `/devflow:implement <slug>`；若要完整方案，先升级 `/devflow:req <slug>` 产出 `req.md`。门禁未过时先回到 `/devflow:req`，不要凭空设计方案。
4. 阅读相关代码，确认真实入口、数据结构与依赖。
5. 按改动规模分级，决定方案深度；新增依赖、新子系统或架构性选择必须调研已有实现：
   - 用外部社区会用的词检索 GitHub、官方文档与开源项目；
   - 候选至少核对来源、许可证、维护状态与项目约束；
   - 搜索失败时按 SKILL 的「搜索失败协议」降级并留痕，不得把“没搜到”写成“没有”。
6. 按 SKILL 产出方案：推荐方案 + 候选取舍 + 被否方案及原因、任务拆分表、测试策略、回滚、风险。
7. 已有 superpowers `brainstorming` 结果或 `writing-plans` 计划时，把结论吸收进 `plan.md`，不并存两份设计/计划。
8. 逐条对照需求验收标准，确认都能映射到任务或测试；不能映射的指出来。
9. 写入 `docs/devflow/<slug>/plan.md`，并报告实际 slug、写入路径、任务数、最大风险、复用结论与未验证项。
10. 方案确认后进入实现阶段：`/devflow:implement <实际 slug>`。
