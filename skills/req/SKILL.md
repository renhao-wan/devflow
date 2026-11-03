---
name: req
description: 需求阶段：澄清目标、验收标准与边界，产出 req.md
argument-hint: <需求描述或 slug> [--light] [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Skill, Bash(ls:*), Bash(git status:*), Bash(git diff:*), Bash(node:*), Bash(devflow:*)
---

对以下诉求执行 devflow 需求阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/req/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/req/SKILL.md`；文件不存在时提示先运行 `/devflow:init`，然后停止。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage req <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage req <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - 参数含 `--light` 时，轻量流程不切换工具：给路由命令附加 `--force-devflow`，避免 BMAD、Spec Kit、OpenSpec 等 workflow 工具接管 req 阶段。若同时显式传 `--tool <id>`，说明轻量模式下该参数不生效；需要改用其他工具或完整规格流程时，去掉 `--light` 后重新执行。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:brainstorming`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 读取 `.claude/hub/hub.yaml` 了解子项目与阶段划分；若 `.claude/hub/project-overview.md` 存在，读取技术栈、子项目与顶层目录段作为定位起点，以代码和 hub.yaml 为准。
3. 按 SKILL 中的执行步骤工作：
   - 先复述目标，再只问阻塞性问题（一次最多 3 个）。
   - 能通过读代码确认的事实，先读代码，不反问用户。
   - 记录技术约束（是否允许新增依赖、许可证政策、运行时、离线/部署要求），作为 plan 阶段复用判断的输入。
4. 严格遵守 SKILL 中的门禁，逐条自查；验收标准统一带唯一验收 ID（`AC-1`、`AC-2`…），不满足就继续澄清，不进入方案。
5. 产出写入 `docs/devflow/<slug>/req.md`。slug 使用 kebab-case，从需求内容提炼；目录不存在时创建。
   - 参数含 `--light` 时走轻量功能：产出 `brief.md`（合并 req 与 plan），不写 `req.md`/`plan.md`；硬触发（依赖、公共接口/契约、数据结构/迁移、权限/认证/支付/并发/安全边界、不可逆操作、>200 行、>10 文件、>2 子项目）必须升级完整流程。
   - 轻量模式在进入 implement 前后运行升级自检 `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-triage.mjs" --root . --escalate`（未设置插件根时用 `node scripts/devflow-triage.mjs --root . --escalate`）。退出码 1 表示命中可由 diff 推导的硬触发，停止轻量并写 `## 升级判断`；退出码 0 也不能替代人工判断不可逆操作与跨模块影响。
   - 写 `brief.md` 前检查目标目录：已有 `req.md` 或 `plan.md` 时，说明该 slug 已是完整流程，改用完整 req 或换 slug，不新增 brief.md，避免产物被完整流程覆盖而静默失效。
   - 轻量流程出现 80–200 行或 5–10 个文件的软提示时，用 `AskUserQuestion` 询问是否继续轻量；无法提问时回退为文本询问。
   - 写完产物后运行 `node scripts/devflow-check.mjs --root . --stage req --slug <slug>`（插件根可用时用 `devflow check --stage req`）；退出码非 0 表示目标、验收、本次不做、约束或影响面等结构缺失，按输出补齐后重跑。
6. 最后用一段话报告：实际 slug、任务目录 `docs/devflow/<实际 slug>/`、目标、验收标准数量、本次不做的项、技术约束、影响面、遗留待确认项。
7. 完成后进入下一阶段：轻量功能 `/devflow:implement <实际 slug>`；完整流程 `/devflow:plan <实际 slug>`（把 `<实际 slug>` 替换为本次生成的 slug）。
