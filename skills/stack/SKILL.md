---
name: stack
description: 按需安装、更新、恢复或删除技术栈包（stack packs）
argument-hint: <add|list|update|restore|remove|status|lock|lint|cache> [...]
allowed-tools: Bash(node:*), Read, Glob, Grep
disable-model-invocation: true
---

对当前项目运行技术栈包命令。

优先使用项目内 loader：

```bash
node scripts/devflow-stack.mjs $ARGUMENTS
```

不存在时直接调用插件脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-stack.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

规则：

1. `add` 必须显式提供 `--repo <url>`、`--from <dir>` 或环境变量 `DEVFLOW_STACK_REPO`；不要猜测默认源。
2. 安装成功后，提醒用户把 `stack: <installedAs>` 写入 `.claude/hub/hub.yaml` 的顶层或对应 `subprojects`，再运行 `gen`。
3. `status`、`list`、`lint` 只读；`remove`、`restore --force`、`update --force` 属于破坏性操作，执行前必须向用户确认。
4. 不修改 pack 缓存中的快照，也不手工编辑 `.claude/.stack-sources.json`。
