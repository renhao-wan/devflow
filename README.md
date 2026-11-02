# devflow

Claude Code 的六阶段工程工作流插件：需求、计划、实现、测试、评审、调试。

核心思路只有一句：**规范正文只放一份（项目 `.claude/hub/`），Claude Code 看到的只是薄壳投影。**

## 特性

- **六个阶段**：`req → plan → implement → test → review`，测试或实现失败时进入 `debug` 并回到 `test`；每个阶段都有明确产出与硬门禁。
- **方案前调研**：plan 阶段先查社区、GitHub 与开源项目是否已有实现，按改动级别决定调研深度；搜索失败时显式降级并留痕，不编造来源。
- **单一真源**：项目规则只维护 `.claude/hub/`；`.claude/skills/devflow-*` 是生成物，不手改。
- **阶段资源**：每个阶段可带 `references/`（细则）与 `templates/`（产出骨架），按需读取，避免把长清单塞进主文件。
- **多根工作区**：自动探测 `services/api` 这类两层子项目，Maven `<modules>` 展开为模块级条目，测试命令统一从工作区根执行。
- **安全门禁**：系统级破坏命令直接拒绝，有丢数据风险的操作要求确认，未测试改动只提醒不阻止。
- **可回灌、可升级**：项目里打磨过的阶段规则与共享规则可回灌到插件模板，本地写入或直接开 PR；插件升级后用 `/devflow:sync` 非破坏性同步，手改文件自动三方合并、冲突时保留并可备份。

## 前置要求

- Claude Code（支持 `/plugin` 命令）。
- Node.js：**>= 20.11**（测试使用了 `import.meta.dirname`）。
- `node` 可在 `PATH` 中找到（hooks 通过它执行）。
- 无第三方依赖，无需 npm install。

## 安装

从 GitHub 安装：

```bash
# 在 Claude Code 中把仓库加入 marketplace
/plugin marketplace add renhao-wan/devflow

# 安装插件
/plugin install devflow@devflow-marketplace
```

如果是在本机修改插件本身，也可以把本地仓库路径传给 `/plugin marketplace add`。

无需发布到公开市场，也不需要 npm。安装或修改 hooks 后需要重启 Claude Code 会话生效。

## 快速开始

### 1. 初始化工作区

在工作区根目录执行：

```bash
/devflow:init
```

会完成：

1. 创建 `.claude/hub/`，复制六个阶段的模板（含 `references/`、`templates/`）。
2. 写入 `hub.yaml`，自动探测子项目、包管理器与测试命令。
3. 在 `scripts/` 放五个薄 loader（`devflow-gen` / `devflow-doctor` / `devflow-route` / `devflow-upstream` / `devflow-test`）。loader 是生成物，会写进 `.gitignore`，换机器或重跑 init 时自动重建。
4. 生成 `.claude/skills/devflow-*` 投影。
5. 写入 `.gitignore` 片段（用标记块原地更新，重复运行不会叠加），忽略生成物与 loader。

初始化后请检查 `.claude/hub/hub.yaml`，尤其是自动探测的测试命令。看到 `.claude/skills/devflow-*` 投影即表示初始化成功。探测规则与需要人工复核的场景见 [usage.md](docs/usage.md#多根工作区)。

### 2. 走一遍流程

以 `add-login` 为例（下文假设 slug 为 `add-login`）：

```bash
/devflow:req 给登录页增加短信验证码
/devflow:status            # 确认实际 slug 与下一步命令
/devflow:plan add-login
/devflow:implement add-login
/devflow:test add-login
/devflow:review add-login
```

产物默认写入 `docs/devflow/add-login/`：

```
req.md      # 目标、验收标准、边界、影响面
plan.md     # 方案、任务拆分、测试策略、回滚
brief.md    # 轻量功能：目标、验收标准、改动范围与测试计划（req --light）
test.md     # 命令、结果、覆盖、未覆盖项
review.md   # 阻断项、建议项、测试缺口、结论
debug.md    # 现象、根因、修复、回归证据（轻量修复只需这一份）
```

流程按风险缩放，小功能与小 bug 走不同入口：

| 类型 | 入口 | 产物 | 何时结束 |
| --- | --- | --- | --- |
| 完整任务 | `/devflow:req <需求>` | `req.md → plan.md → test.md → review.md` | review 无阻断项 |
| 小功能 | `/devflow:req --light <需求>` | `brief.md → test.md → review.md` | review 无阻断项 |
| 小 bug | `/devflow:debug <问题>` | `debug.md → test.md` | 普通测试通过即结束；`review: required` 时补 review |

轻量只压缩文档，不减测试：小功能始终保留 review；小 bug 普通修复在测试通过后结束，涉及安全、数据、认证/权限/并发风险且不触发升级时，用 `debug.md` 顶部的 `review: required` 补审。升级条件与完整规则见 [usage.md](docs/usage.md#轻量流程)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/devflow:init [--force] [--source-root <插件源码仓库>]` | 初始化工作区 hub，探测子项目与测试命令 |
| `/devflow:req <需求> [--light]` | 需求澄清，产出 `req.md`；`--light` 时合并为 `brief.md` |
| `/devflow:plan <slug>` | 方案设计，产出 `plan.md` |
| `/devflow:implement <slug>` | 按计划或 `brief.md` 小步实现，测试先行 |
| `/devflow:test <slug>` | 运行与补充测试，记录真实结果 |
| `/devflow:review <slug>` | 差异导向审查，输出阻断项与建议项 |
| `/devflow:debug <问题>` | 系统化排障，先复现后修复；独立小 bug 产出 `debug.md` |
| `/devflow:doctor [--json]` | 体检版本、投影、资源、hooks、测试状态 |
| `/devflow:onboard [--print] [--json]` | 扫描技术栈、目录、子项目、入口与 CI，生成 `project-overview.md`；重扫只刷新自动段 |
| `/devflow:status [--slug <slug>] [--json]` | 只读查看进度、产物缺口与下一步命令 |
| `/devflow:upstream [--stage <stage>] [--shared] [--all] [--to local\|remote] [--apply] [--bump patch\|minor\|major] [--revert <id>]` | 把项目经验回灌到插件模板（本地或远程 PR） |
| `/devflow:ship [--stage <stage>] [--shared] [--all] [--bump patch\|minor\|major] [--dry-run] [--resume <branch>]` | 回灌后提交到分支、推送并生成 PR |
| `/devflow:sync [--dry-run] [--force]` | 插件升级后非破坏性同步阶段与共享模板，手改内容自动三方合并 |

命令与技能已统一：这些入口实际是 `skills/<name>/SKILL.md`，斜杠调用方式不变。`init` / `onboard` / `upstream` / `ship` / `sync` 标了 `disable-model-invocation`，只能由用户显式触发，避免模型自行改写工作区或插件仓库。

已产出的阶段文件就是进度记录：完整任务依次是 `req.md → plan.md → test.md → review.md`，小功能用 `brief.md` 替代前两份，小 bug 从 `debug.md` 开始。不确定当前进度时先运行 `/devflow:status`，它只读扫描 `docs/devflow/`，报告每个任务的阶段、流程类型、缺口和建议的下一步命令，不写任何状态。只有一个任务时工作流命令可省略 slug；存在多个任务时会列出候选，不会替你选择，也不使用 `latest` 兜底。

插件同时提供统一 CLI（`bin/devflow`，安装后命令名为 `devflow`）：

```bash
devflow init
devflow gen
devflow doctor --json
devflow status --json
devflow route --stage plan
devflow route --detect
devflow sync --dry-run
devflow upstream --shared --apply
devflow ship --stage review --dry-run
devflow upstream --revert <id>
```

等价于 `node scripts/<script>.mjs`；参数原样透传，`devflow help` 查看全部命令。阶段入口会自动执行 `devflow route --stage <stage>`，手动运行主要用于排查与脚本集成。

## 六个阶段

| 阶段 | 职责 | 关键门禁 |
| --- | --- | --- |
| req | 把模糊诉求变成可验证需求 | 验收标准可观察；写明本次不做；影响面具体 |
| plan | 调研已有实现，给出方案、任务拆分、测试策略与回滚 | 引用真实文件；任务可独立验证；复用结论有来源；有回滚 |
| implement | 按计划或 `brief.md` 小步实现，优先 TDD | 每步可运行；无无关改动；计划与实际同步 |
| test | 真实运行测试并记录证据 | 全量已跑；改动有直接覆盖；未运行不得写通过 |
| review | 按风险审查差异 | 无未处理阻断项；敏感信息扫描通过 |
| debug | 复现、定位根因、补回归测试 | 有复现；根因有证据；回归测试修复前失败 |

每个阶段的完整规则在 `.claude/hub/stages/<stage>/SKILL.md`，执行前必须完整读取。阶段细节、轻量流程与方案调研要求见 [usage.md](docs/usage.md)。

## 原生能力与 statusline

- `/goal`：implement、test、debug 跨多回合时可提示用户运行 `/goal` 设置完成条件；插件不会自动设置，也不替代门禁。
- `/rewind`：回到检查点，会丢弃当前会话改动；执行前先确认范围。
- `/worktree`：隔离并行实验，避免把实验代码留在主工作区。
- `/code-review`：可选的本地第二视角；`/security-review`、`/ultrareview` 可能上传代码，必须先征得用户同意；`/simplify` 若应用修改，回到 implement 并重新 test。

可选的 statusline 复用 `scripts/statusline.mjs` 的只读推导，在用户或项目 `settings.json` 中配置 `statusLine`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "devflow statusline"
  }
}
```

完整配置、根目录推导与降级行为见 [usage.md](docs/usage.md#statusline可选)；原生能力的版本要求与降级说明见 [docs/native-capabilities.md](docs/native-capabilities.md)。

## 工具路由

项目可以在 `.claude/hub/ecosystem.yaml` 登记同类工具（superpowers、BMAD、Spec Kit、OpenSpec 等）。阶段入口会先运行 `devflow route --stage <stage>`，判断是否有更合适的工具执行本阶段技法；路由只决定“谁执行技法”，阶段顺序、门禁与产物始终由 devflow 负责。默认 `ask` 模式会先询问，`auto` 只自动委派 `kind: technique` 的工具，配置缺失或检测失败时回退 devflow。

配置、检测范围、决策优先级与命令参见 [docs/tool-routing.md](docs/tool-routing.md)。

## 与 superpowers 的关系

devflow 管**阶段与门禁**（阶段顺序、产物路径、项目真源、回灌与同步），superpowers 管**执行技法**（brainstorming、writing-plans、TDD、systematic-debugging、代码评审、verification、worktrees）。冲突时以 devflow 的阶段门禁与产物路径为准，已有设计或计划吸收进 `plan.md`，不并存两份；未安装 superpowers 时，devflow 自带技能作为 fallback。详见 [design.md](docs/design.md) 与 [comparison.md](docs/comparison.md)。

## 文档地图

| 场景 | 文档 |
| --- | --- |
| 阶段细节、`hub.yaml`、多根工作区、statusline | [docs/usage.md](docs/usage.md) |
| hooks、危险命令拦截与生成物保护 | [docs/hooks.md](docs/hooks.md) |
| 回灌、升级、ship/PR 与故障排查 | [docs/maintenance.md](docs/maintenance.md) |
| 脚本、目录结构、测试、CI 与版本兼容 | [docs/development.md](docs/development.md) |
| 工具路由 | [docs/tool-routing.md](docs/tool-routing.md) |
| Claude Code 原生能力接入 | [docs/native-capabilities.md](docs/native-capabilities.md) |
| 设计、对比与适用边界 | [docs/design.md](docs/design.md)、[docs/comparison.md](docs/comparison.md)、[docs/value-and-limits.md](docs/value-and-limits.md) |

完整索引与推荐阅读顺序见 [docs/README.md](docs/README.md)。

## 安全边界

- 危险命令拦截是**基于正则的尽力拦截**，不是安全沙箱；规则与已知绕过风险见 [docs/hooks.md](docs/hooks.md)。
- 漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 卸载

```bash
/plugin uninstall devflow
rm -rf .claude/hub .claude/skills/devflow-* .claude/.hub-manifest.json .claude/.hub-sources.json .claude/.devflow-state.json scripts/devflow-*.mjs .devflow.json
```

`.claude/` 下你自己写的其他技能不受影响。`.claude/hub/` 是项目真源，删除前请确认其中的规则已备份或不再需要。

## 许可

MIT，见 `LICENSE` 与 `.claude-plugin/plugin.json`。
