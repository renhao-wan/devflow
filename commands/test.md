---
description: 测试阶段：运行测试、补齐覆盖、记录可验证的结果
argument-hint: [slug]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(*)
---

执行 devflow 测试阶段：**$ARGUMENTS**

1. 读取 `.claude/hub/stages/test/SKILL.md` 与 `.claude/hub/hub.yaml`，确定测试命令（子项目优先，其次默认）。
2. 先跑全量测试，记录真实结果（通过/失败数量、失败用例）。
3. 针对本次改动补测正常路径、边界、错误路径；测试文件缺失时补齐。
4. 测试失败时不要改断言迁就实现，转入 `/devflow:debug`。
5. 全部通过后运行：

```bash
node scripts/devflow-test.mjs --command "<实际使用的命令>"
```

6. 将结果写入 `docs/devflow/<slug>/test.md`（slug 未知时用 `latest`），包括：命令、环境、结果、覆盖说明、未覆盖项、手动验证项。
7. 报告时区分「自动化已通过」「手动验证过」「未验证」，不得混写。
