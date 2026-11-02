# Claude Code 原生能力与 devflow

日期：2026-11-02

本文记录 devflow 对 Claude Code 原生能力的接入方式、版本要求与降级行为。核对基线为 Claude Code 2.1.234；`/goal` 的可用版本参考官方 changelog（2.1.139+）。版本信息会变化，升级后请用 `/agents`、`/help`、`/config` 与实际工具列表复核。

## 原则

1. **只接原生原语**：不引入状态机、dashboard 或 MCP server。
2. **保留人工门禁**：goal、子代理和自动提示都不能替代 req/plan/review 的确认。
3. **全部可降级**：旧版本、非交互模式、子代理失败时回退为主上下文执行，不阻断流程。
4. **外发需确认**：可能把代码上传到外部服务的命令必须先征得用户同意。

## 能力矩阵

| 能力 | 当前接入 | 版本/条件 | 不可用时的降级 |
| --- | --- | --- | --- |
| Skills / 斜杠命令 | 阶段入口、通用技能、`allowed-tools`、`argument-hint`、`disable-model-invocation` | 基础能力 | 仍可用 `/devflow:*` 手动调用 |
| `Agent` / 子代理 | `debug`、`test`、`review` 可调用三个项目子代理；`debug` 支持并行假设验证 | 工具名可能为 `Task` 或 `Agent` | 工具不可用时在主上下文执行 |
| 并行子代理 | `debug` 对 ≥2 个独立假设并行调查；`review` 高风险时并行双视角审查 | 一条消息发起多个 Agent 调用 | 串行执行或主上下文分视角自查 |
| 子代理命名 | 文档使用 `devflow:<agent>`；旧版本可能为裸名 | 取决于插件命名空间 | 以 `/agents` 列表中的名称为准 |
| `AskUserQuestion` | 多 slug、软阈值、升级与委派确认 | 交互会话 | 非交互模式回退为文本提问 |
| `/goal` | `implement`、`test`、`debug` 可选完成条件模板与入口提示；不自动设置 | 2.1.139+ | 不使用 goal，按产物与测试门禁推进 |
| plan mode | `plan` 阶段在用户同意后用 `EnterPlanMode` / `ExitPlanMode`；plan mode 内不写文件 | 交互会话 | 直接在普通模式调研并写 `plan.md` |
| `Plan` / `Explore` 子代理 | `plan` 阶段用 `Explore` 定位、`Plan` 设计方案；结论需本地核对 | 内置 agent | 主上下文用 Read/Grep/Glob 调研 |
| Hooks | `PreToolUse`、`PostToolUse`、`Stop`、`SessionStart` | 基础能力 | 钩子异常时 fail-open |
| `SessionStart` 注入 | `additionalContext` + `reloadSkills`，覆盖 compact/fork | 基础能力 | 无注入时仍按产物与 hub 工作 |
| statusline | 可选脚本读取 `devflow status --json` 数据 | 用户配置 | 不配置时用 `/devflow:status` |
| `context: fork` | 只读调研技能在独立上下文运行 | 较新版本 | 不支持时普通技能执行 |
| `disallowed-tools` | 只读调研技能显式禁用写工具 | 较新版本 | 不支持时靠 `allowed-tools` 限制 |
| 内置审查命令 | review 阶段建议按风险使用 `/ultrareview`、`/security-review` 等 | 取决于命令可用性 | 使用 `devflow-code-reviewer` |
| MCP | 不作为依赖；需手动登记到 `ecosystem.yaml` | 可选 | 未登记时路由看不到 MCP 工具 |

## 子代理命名

插件子代理在运行时通常带插件前缀：

- `devflow:devflow-code-reviewer`
- `devflow:devflow-debug-investigator`
- `devflow:devflow-test-runner`

部分版本或客户端可能显示裸名。阶段技能同时写明两种形式，并明确“以 `/agents` 列表为准”。如果 `Agent` 工具不可用，但 `Task` 可用，保留 `Task` 作为兼容入口；两者都不支持时在主上下文执行，不假装已委派。

## 版本与降级

- **先探测再使用**：阶段技能在调用子代理或 `AskUserQuestion` 前不需要额外探测；工具不可用时按文档回退。
- **不猜测版本号**：除 `/goal` 外，本文不为其他能力标注精确最低版本；以实际工具列表和 `claude --help` 为准。
- **非交互模式**：`-p`、Remote Control 或权限模式不允许提问时，不调用 `AskUserQuestion`，改为文本列出选项。
- **hook 兼容**：现有 `hooks.json` 使用 `command` 字符串形式；新版 `args` 执行形式作为可选优化，不强制启用。
- **外发边界**：`/ultrareview`、`/security-review` 等可能调用云端服务，必须由用户确认后执行。

## 明确不使用的能力

| 能力 | 原因 |
| --- | --- |
| 状态机 / dashboard | 与“产物即状态”的轻量设计冲突，容易漂移 |
| 强制 TodoWrite | 当前新模型默认不启用 Todo/task-tracking 工具 |
| 默认启用 `/goal` 自动推进 | 会绕过阶段门禁与人工确认 |
| MCP server 依赖 | 保持无外部服务、可离线使用的定位 |
| 自动云端审查 | 代码外发必须显式授权 |
