---
name: help
description: 查看 devflow 的全部命令、按场景选择入口，或查看单个命令的用法；用户问“怎么用 / 有哪些命令 / 该用哪个”时使用
argument-hint: [命令名]
allowed-tools: Bash(node:*), Bash(devflow:*), Read
---

查看 devflow 帮助。只读操作，不写文件、不执行任何阶段命令。

优先使用插件自带的 CLI 入口：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/devflow" help "$ARGUMENTS"
```

`CLAUDE_PLUGIN_ROOT` 未设置时改用：

```bash
devflow help "$ARGUMENTS"
```

规则：

1. 参数只接受一个命令名，不要拼接额外参数或猜测命令；空参数时显示总帮助。命令名由 CLI 校验，未知命令会退出 1。
2. 无参数时先展示“按场景选入口”，再展示命令列表。用户问“怎么开始”时，只推荐最贴合的一条入口，不要一次倾倒全部细节。
3. 带命令名时展示该命令的描述与用法；需要更多参数细节时指向 `docs/usage.md`。
4. 两条命令都不可用时，按内置场景表回答：新项目用 `/devflow:init`，小功能用 `/devflow:req --light`，小 bug 用 `/devflow:debug`，不确定进度用 `/devflow:status`，熟悉项目用 `/devflow:onboard`，体检用 `/devflow:doctor`；并提示查看 README 或 `docs/quickstart.md`。不要编造命令参数。
5. 不要因为用户问了某个阶段就自动执行该阶段；help 只负责说明入口。
