---
description: 回灌：把项目里改进过的阶段模板回馈到插件（默认只预览）
argument-hint: --stage <stage> [--apply] [--root <path>]
allowed-tools: Bash(node:*), Bash(git diff:*), Read, Glob, Grep, Write, Edit
---

执行 devflow 回灌：**$ARGUMENTS**

1. 必须包含 `--stage <req|plan|implement|test|review|debug>`；缺失时列出六个阶段并停止。
2. 默认先预览（不加 `--apply`）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-upstream.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

3. 向用户解释分类结果：
   - `[可回灌]`：通用内容，可进入插件模板。
   - `[项目专属]`：命中绝对路径、内网地址、子项目名或 blocklist，不会回灌。
4. 只有用户明确同意后才追加 `--apply`。执行后会写入插件模板、追加回灌日志、bump patch 版本并更新 CHANGELOG。
5. 回灌后提醒用户：运行 `/devflow:doctor` 验证，并对插件做一次提交。
6. 不要回灌包含密钥、内网地址、公司内部信息的内容；发现时直接停下并告知用户。
