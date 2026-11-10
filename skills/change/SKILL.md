---
name: change
description: 重开阶段：归档指定阶段及其下游产物，默认只预览
argument-hint: --slug <slug> --from <req|plan|test|review> [--purge] [--apply] [--json]
allowed-tools: Bash(node:*), Read, Glob, Grep, AskUserQuestion
disable-model-invocation: true
---

重开 devflow 阶段：**$ARGUMENTS**

优先使用项目内 loader：

```bash
node scripts/devflow-change.mjs --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

不存在时直接调用插件脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-change.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

规则：

1. 默认只预览，不移动任何文件。用户参数里若含 `--apply`，预览阶段必须去掉它。
2. `--from req|plan` 保留该阶段文档供修改，归档其下游；`--from test|review` 归档该阶段执行记录及下游。`brief`、`debug` 可作为 `req` 的别名。
3. `--purge` 只对 `req|plan` 生效，连该阶段自身一起归档；`--from req --purge` 后任务不再出现在常规列表，`status` 会把它列为“已归档任务”，重新开始运行 `/devflow:req <slug>`。执行前必须用 `AskUserQuestion` 向用户确认。
4. 归档目录是 `docs/devflow/<slug>/.archive/<时间戳>/`，其中 `manifest.json` 记录归档原因与文件。归档默认被 `.gitignore` 忽略（旧项目重跑 `/devflow:init` 更新规则）；需要保留某次归档时用 `git add -f`，否则确认无需恢复后删除。
5. 用户确认预览内容后才在命令上追加 `--apply`。没有可归档文件时命令会输出“无需归档”并成功退出。
6. 回退后的阶段由产物存在性推导：`--from test` 归档测试记录后，`status` 可能显示 `implement`，下一步以命令输出的提示为准（通常是 `/devflow:test`）。
7. `clean --docs` 会连同 `.archive` 一起删除；需要长期保留时先复制出去。
