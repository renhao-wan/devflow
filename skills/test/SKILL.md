---
name: test
description: 测试阶段：运行测试、补齐覆盖、记录可验证的结果
argument-hint: [slug] [--force-devflow]
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Skill, Bash(*)
---

执行 devflow 测试阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/test/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/test/SKILL.md` 与 `.claude/hub/hub.yaml`，确定测试命令（子项目优先，其次默认）。
   - 工具路由（可跳过）：运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-route.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" --stage test <用户参数>`；未设置 `CLAUDE_PLUGIN_ROOT` 时用 `node scripts/devflow-route.mjs --stage test <用户参数>`。用户参数中的 `--force-devflow` 原样透传。
   - `use-devflow`：直接继续本阶段。
   - `suggest`：说明候选工具与理由并询问；用户未同意时继续 devflow。
   - `delegate`：在技能上下文中用 `Skill` 工具调用 `invoke`（去掉前导 `/`，如 `superpowers:verification-before-completion`）；无法调用时说明原因并询问是否继续 devflow。阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由本阶段负责。
   - `error`：停止并报告命令输出中的原因，不要继续本阶段。
2. 未提供 slug 时，扫描 `docs/devflow/*/plan.md`、`docs/devflow/*/brief.md` 与 `docs/devflow/*/debug.md`，按 slug 去重：只有一个候选就采用；多个时列出候选让用户选择，不要自行挑选，也不要用 `latest` 代替；没有候选时提示先运行 `/devflow:status` 或确认 slug。同一 slug 存在多套产物时按完整流程优先（`plan.md` > `brief.md` > `debug.md`）。若目录有 `req.md` 却缺 `plan.md`，返回 `/devflow:plan`，不要用 `brief.md` 冒充计划。
3. 先跑全量测试，记录真实结果（通过/失败数量、失败用例）；可用 `devflow-test-runner` 子代理执行并汇总，但报告需自己核对。
4. 针对本次改动补测正常路径、边界、错误路径；测试文件缺失时补齐。轻量修复的回归测试须与 `debug.md` 记录的「命令 / 修复前失败输出 / 修复后通过输出」一致。
5. 测试失败时不要改断言迁就实现，转入 `/devflow:debug`。
6. 全部通过后运行：

```bash
node scripts/devflow-test.mjs --command "<实际使用的命令>"
```

7. 将结果写入 `docs/devflow/<slug>/test.md`，包括：命令、环境、结果、覆盖说明、未覆盖项、手动验证项。
8. 报告时区分「自动化已通过」「手动验证过」「未验证」，不得混写。
9. 全部通过后：轻量功能与完整任务进入 `/devflow:review <slug>`；轻量修复读取 `debug.md` 顶部前 10 行，标记 `review: required` 才进入审查，否则到此结束。测试失败按第 5 步转入 `/devflow:debug`。
