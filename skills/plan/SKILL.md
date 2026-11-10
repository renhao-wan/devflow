---
name: plan
description: 方案阶段：基于 req.md 调研已有实现，产出技术方案、任务拆分与测试策略
argument-hint: <slug 或任务描述> [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, Skill, Bash(gh:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(node:*), Bash(devflow:*)
---

对以下需求执行 devflow 方案阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/plan/SKILL.md` 冲突时，以 SKILL 为准。

1. 先读项目投影 `.claude/skills/devflow-plan/SKILL.md`（含共享规则、子项目覆盖与技术栈映射），再按其中「单一真源」读取 `.claude/hub/stages/plan/SKILL.md`。
   - 投影缺失：直接读 hub 源，并提示运行 `node scripts/devflow-gen.mjs`；两者都缺失时提示先运行 `/devflow:init`。
   - 任务涉及子项目时，只按投影的「技术栈规范」读取对应栈文件；`overrides` 优先于栈规范，任何规则都不得放宽门禁与安全底线。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage plan <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage plan <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:brainstorming`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/req.md`：只有一个候选就采用；多个时用 `AskUserQuestion` 让用户选择，不要自行挑选，也不要用 `latest` 代替；无法提问时列出候选并等待回复。没有 `req.md` 时，说明完整方案阶段需要 `req.md`：若目录只有 `brief.md`，提示直接 `/devflow:implement <slug>`（轻量功能）；若都没有，提示先运行 `/devflow:req`（小改动加 `--light`）。
3. 找到并完整读取 `docs/devflow/<slug>/req.md`。缺失时：若目录只有 `brief.md`，说明这是轻量功能，提示直接 `/devflow:implement <slug>`；若要完整方案，先升级 `/devflow:req <slug>` 产出 `req.md`。门禁未过时先回到 `/devflow:req`，不要凭空设计方案。
4. 阅读相关代码，确认真实入口、数据结构与依赖；若 `.claude/hub/project-overview.md` 存在，先读其技术栈、子项目与关键入口段辅助定位，再以代码为准。大范围定位优先用 `devflow:devflow-plan-research` 技能（独立上下文、只读）；不可用时用 `Explore` 子代理（very thorough）返回路径、符号与引用关系，再自己读关键文件，不把摘要当结论。
5. 按改动规模分级，决定方案深度；新增依赖、新子系统或架构性选择必须调研已有实现：
   - 用外部社区会用的词检索 GitHub、官方文档与开源项目；
   - 候选至少核对来源、许可证、维护状态与项目约束；
   - 搜索失败时按 SKILL 的「搜索失败协议」降级并留痕，不得把“没搜到”写成“没有”。
   - 复杂架构或取舍困难时，可调用 `Plan` 子代理产出方案与风险，由本阶段核对后写入 `plan.md`，不替用户决策。
6. 按 SKILL 产出方案：推荐方案 + 候选取舍 + 被否方案及原因、任务拆分表、测试策略、回滚、风险。
7. 已有 superpowers `brainstorming` 结果或 `writing-plans` 计划时，把结论吸收进 `plan.md`，不并存两份设计/计划。
8. 逐条对照需求验收标准，确认都能映射到任务或测试；在任务拆分表的「验收项」列填写对应验收 ID 并覆盖全部验收项，不能映射的指出来。
9. 需要逐条与用户确认方案时，先征得同意再 `EnterPlanMode`；plan mode 内不改代码、不写文件，写 `plan.md` 前先 `ExitPlanMode`，批准后再写。无法使用或用户拒绝时，直接按 SKILL 产出 `plan.md`，不阻塞流程。
10. 写入 `docs/devflow/<slug>/plan.md`，并报告实际 slug、写入路径、任务数、最大风险、复用结论与未验证项。写完后运行 `node scripts/devflow-check.mjs --root . --stage plan --slug <slug>`（插件根可用时用 `devflow check --stage plan`）；退出码非 0 表示核心段落、任务表必填列、验收覆盖或 AC 引用有问题，按输出补齐后重跑。
11. 方案确认后进入实现阶段：`/devflow:implement <实际 slug>`。
12. 计划变更后重跑受影响的实现与测试；需要归档下游时用 `devflow change --slug <slug> --from plan --apply`，它会保留 `plan.md` 并归档 test/review 与 triage。
