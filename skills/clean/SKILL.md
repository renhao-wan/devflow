---
name: clean
description: 清理工作区里的 devflow 产物，默认只预览，可分层删除项目真源与任务记录
argument-hint: [--apply] [--hub] [--docs] [--all] [--json]
allowed-tools: Bash(node:*), Read, Glob, Grep, AskUserQuestion
disable-model-invocation: true
---

清理当前项目的 devflow 产物：**$ARGUMENTS**

优先使用项目内 loader：

```bash
node scripts/devflow-clean.mjs --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

不存在时直接调用插件脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-clean.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

规则：

1. 默认只预览，不删除任何文件。用户参数里若含 `--apply`，预览阶段必须去掉它。
2. 向用户展示将删除与保留的清单，说明档位：默认只删可再生生成物；`--hub` 追加 `.claude/hub/`（项目真源，含手写规则）；`--docs` 追加 `docs/devflow/`（任务记录）；`--all` 两者都删。`.claude/.stack-trash/`、`.claude/.devflow-trash/` 与 `docs/upstream-log.md` 始终保留。
3. `--hub`、`--docs`、`--all` 删除的是不可再生数据，执行前必须向用户确认；确认后才在预览命令上追加 `--apply`。
4. 删除项会先移到 `.claude/.devflow-trash/<时间戳>/`，输出中给出路径。执行结束后提醒用户：该目录会出现在 `git status`，确认无需恢复后手动删除。
5. 清理后 devflow 对该项目不再生效。若要彻底卸载插件，顺序必须是**先运行本命令，再执行 `/plugin uninstall devflow`**；插件卸载后本命令不可用。
6. 只清理当前 hub 根。多根工作区里另有独立初始化的仓库不会被处理，需要分别进入对应根目录运行。
7. 没有找到任何 devflow 锚点时输出“未发现工作区”并成功退出，不要按当前目录猜测路径。
