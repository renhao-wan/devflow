---
name: test
description: 测试阶段：运行测试、补齐覆盖、记录可验证的结果
argument-hint: [slug] [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Agent, AskUserQuestion, Skill, Bash(*)
---

执行 devflow 测试阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/test/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/test/SKILL.md` 与 `.claude/hub/hub.yaml`，确定测试命令（子项目优先，其次默认）。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage test <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage test <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:verification-before-completion`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/plan.md`、`docs/devflow/*/brief.md` 与 `docs/devflow/*/debug.md`，按 slug 去重：只有一个候选就采用；多个时用 `AskUserQuestion` 让用户选择，不要自行挑选，也不要用 `latest` 代替；无法提问时列出候选并等待回复。没有候选时提示先运行 `/devflow:status` 或确认 slug。同一 slug 存在多套产物时按完整流程优先（`plan.md` > `brief.md` > `debug.md`）。若目录有 `req.md` 却缺 `plan.md`，返回 `/devflow:plan`，不要用 `brief.md` 冒充计划。
3. 先跑全量测试，记录真实结果（通过/失败数量、失败用例）；可用 `devflow:devflow-test-runner` 子代理执行并汇总（旧版本可能显示为 `devflow-test-runner`，以 `/agents` 列表为准），但报告需自己核对。
4. 针对本次改动补测正常路径、边界、错误路径；测试文件缺失时补齐。可先运行 `node scripts/devflow-test.mjs --changed` 列出可能受影响的已存在测试（只提示、不执行、不阻断；`[UNMAPPED]` 的源码文件优先跑全量）。轻量修复的回归测试须与 `debug.md` 记录的「命令 / 修复前失败输出 / 修复后通过输出」一致。
5. 运行测试缺口提示（只提示，不阻断）：

```bash
node scripts/devflow-test.mjs --gaps
```

   按输出逐条确认：已有测试覆盖（写明测试文件）、新增测试、或明确不测（写明原因）。提示基于文件名与常见测试目录，不解析测试内容。`--gaps` 与 `--changed` 不能同时使用。
6. 测试失败时不要改断言迁就实现，转入 `/devflow:debug`。
7. 记录最近一次真实运行（成功和失败都记）：

```bash
node scripts/devflow-test.mjs --command "<实际使用的命令>" --exit-code <退出码> --duration-ms <耗时>
```

   退出码 0 会更新通过时间并清除待测试标记；非 0 记为失败并保留待测试标记，不会覆盖上次通过时间。缺省 `--exit-code 0` 兼容旧用法。

8. 将结果写入 `docs/devflow/<slug>/test.md`，包括：实际 slug、命令、环境、结果、覆盖说明、未覆盖项、手动验证项。
9. 报告时先给出实际 slug 与 `docs/devflow/<实际 slug>/test.md` 路径，再区分「自动化已通过」「手动验证过」「未验证」，不得混写。
10. 可选：测试跨多回合时，提示用户运行 `/goal` 设置本阶段完成条件（全量与针对性用例已执行、`test.md` 记录真实结果、失败项已处理或明确标记；模板见 `.claude/hub/stages/test/SKILL.md`）。插件不会自动设置 goal；goal 不替代门禁；测试命令或环境未确定时不要建议启用。
11. 全部通过后：轻量功能与完整任务进入 `/devflow:review <实际 slug>`；轻量修复先运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-triage.mjs" --root . --slug <slug> --write`（未设置插件根时用 `node scripts/devflow-triage.mjs`），`trigger` 不是 `skipped`（`review: required`、用户指定方向/数量、安全/数据/并发等风险信号，或无法统计改动时的 `auto`）时进入审查，否则记录基线检查后结束。测试失败按第 6 步转入 `/devflow:debug`。
