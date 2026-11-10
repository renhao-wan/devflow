# devflow

Claude Code 的六阶段工程工作流插件：需求、计划、实现、测试、评审、调试。

核心思路只有一句：**规范正文只放一份（项目 `.claude/hub/`），Claude Code 看到的只是薄壳投影。**

## 特性

- **六个阶段**：`req → plan → implement → test → review`，测试或实现失败时进入 `debug` 并回到 `test`；每个阶段都有明确产出与硬门禁。
- **方案前调研**：plan 阶段先查社区、GitHub 与开源项目是否已有实现，按改动级别决定调研深度；搜索失败时显式降级并留痕，不编造来源。
- **单一真源**：项目规则只维护 `.claude/hub/`；`.claude/skills/devflow-*` 是生成物，不手改。
- **规则落位与草稿**：`init` 生成待填写的规则草稿；不确定一条规范该放 `_shared/`、阶段、技术栈还是子项目覆盖时，用 `devflow-rule-placement` 按最小充分范围判断。
- **阶段资源**：每个阶段可带 `references/`（细则）与 `templates/`（产出骨架），按需读取，避免把长清单塞进主文件。
- **按技术栈复用规范**：在 `.claude/hub/stacks/<stack>/` 维护 Java、Vue 等语言/框架规范，用 `hub.yaml` 的 `stack` 把子项目映射到栈；阶段执行时只读任务涉及子项目的规范，`overrides/` 优先且不得放宽门禁。
- **技术栈包按需安装**：规范已在独立仓库维护时，用 `devflow stack add` 只装单个栈，不 clone 整个仓库；更新走三方合并并保留 `.bak`，提交 `stack-lock.yaml` 后可在新机器恢复。受管栈由 pack 管理，`sync` 与 `upstream` / `ship` 默认不再改写。
- **多根工作区**：自动探测 `services/api` 这类两层子项目，Maven `<modules>` 展开为模块级条目，测试命令统一从工作区根执行。
- **安全门禁**：系统级破坏命令直接拒绝，有丢数据风险的操作要求确认，未测试改动只提醒不阻止。
- **可回灌、可升级**：项目里打磨过的阶段规则与共享规则可回灌到**个人库**（跨项目复用）、**团队库**（团队共享，可开 PR）或**上游插件**；插件升级后用 `/devflow:sync` 非破坏性同步，多来源按团队 > 个人 > 上游合并，手改文件自动三方合并、冲突时保留并可备份；模板引用当前插件没有的 loader 或要求更高版本时会被识别为不兼容并跳过，不会把项目写坏。

## 什么时候不该用

devflow 的价值来自留下可追溯的需求、计划、测试与审查记录。

适合：需要跨会话保持阶段顺序、多人协作，或需要评审证据的项目。

不适合：demo、原型、一次性脚本、几小时内完成的验证。这些场景直接用 Claude Code 更快，产物与门禁会成为负担。

介于两者之间时：小功能用 `/devflow:req --light`，缺陷用 `/devflow:debug`。

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

最短路径（安装 → 初始化 → 第一个任务）见 [docs/quickstart.md](docs/quickstart.md)。按任务规模选一条：

- **小功能或快速验证（推荐第一次这样试）**：`/devflow:init` → `/devflow:req --light <需求>` → `/devflow:implement` → `/devflow:test` → `/devflow:review`。轻量流程用 `brief.md` 合并需求与计划，只压缩文档，不减测试与审查；一次任务通常产出三份文件（`brief.md`、测试记录、审查结论）。
- **需要方案评审、合规留痕或多人接手**：走下面的完整六阶段，产物约五份文档。

规则草稿不阻塞流程，初始化后可以直接开始；需要智能补全时再运行 `/devflow:init --draft`。

### 完整六阶段：初始化工作区

在工作区根目录执行：

```bash
/devflow:init
```

会完成：

1. 创建 `.claude/hub/`，复制六个阶段的模板（含 `references/`、`templates/`），并创建 `_shared/`、`overrides/` 与 `stacks/`。
2. 写入 `hub.yaml`，自动探测子项目、包管理器与测试命令；探测到单一技术栈时自动写入顶层 `stack`。
3. 在 `scripts/` 放一组薄 loader（`devflow-gen` / `devflow-doctor` / `devflow-route` / `devflow-upstream` / `devflow-test` / `devflow-triage` / `devflow-check` / `devflow-trace` / `devflow-stack` / `devflow-clean` / `devflow-change`）。loader 是生成物，会写进 `.gitignore`，换机器或重跑 init 时自动重建。
4. 生成规则草稿：`_shared/project-basics.md`，单栈时还有 `stacks/<stack>/_shared.md`。草稿里的 `TODO:` 是占位，不是规则；默认只生成、不补全，需要智能补全时用 `/devflow:init --draft`。
5. 生成 `.claude/skills/devflow-*` 投影。
6. 写入 `.gitignore` 片段（用标记块原地更新，重复运行不会叠加），忽略生成物与 loader。

初始化后可以直接用 `/devflow:req --light <需求>`（小功能）或 `/devflow:req <需求>`（完整流程）开始，规则草稿不阻塞流程。需要时再检查 `.claude/hub/hub.yaml`（尤其是自动探测的测试命令），填写草稿并删除首行 `<!-- devflow:draft -->`，然后运行 `node scripts/devflow-gen.mjs`；之后新增规则不确定放哪时，用 `devflow-rule-placement`。看到 `.claude/skills/devflow-*` 投影即表示初始化成功。探测规则与需要人工复核的场景见 [usage.md](docs/usage.md#多根工作区)。

### 完整六阶段：走一遍流程

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
| 小 bug | `/devflow:debug <问题>` | `debug.md → test.md` | triage 判定为 `skipped` 时测试通过即结束；其他触发补 review |

轻量只压缩文档，不减测试：小功能始终保留 review；小 bug 测试后由 triage 按实际 diff 判定——`review: required`、用户指定方向/数量、或安全、数据、并发等风险信号会进入 review，非 git 或无法统计改动时也按 `auto` 处理、不自动跳过，其余记录基线检查后结束。升级条件与完整规则见 [usage.md](docs/usage.md#轻量流程)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/devflow:init [--force] [--draft] [--no-draft] [--source-root <插件源码仓库>] [--personal-library <path>] [--team-library <path>]` | 初始化工作区 hub，探测子项目、测试命令与单一技术栈，并生成规则草稿；`--draft` 由技能智能补全草稿，`--no-draft` 跳过草稿；库路径会记录到 `.devflow.json` |
| `/devflow:req <需求> [--light]` | 需求澄清，产出 `req.md`；`--light` 时合并为 `brief.md` |
| `/devflow:plan <slug>` | 方案设计，产出 `plan.md` |
| `/devflow:implement <slug>` | 按计划或 `brief.md` 小步实现，测试先行 |
| `/devflow:test <slug>` | 运行与补充测试，记录真实结果 |
| `/devflow:review <slug> [--focus <方向>]... [--agents 0-4] [--no-subagents] [--focus-only] [--base <ref>] [--since <ref>]` | 先判定触发与风险画像，再按选中方向审查，输出阻断项与建议项；`--since` 用于增量复审 |
| `/devflow:debug <问题>` | 系统化排障，先复现后修复；独立小 bug 产出 `debug.md` |
| `/devflow:doctor [--json]` | 体检版本、投影、资源、hooks、测试状态 |
| `/devflow:onboard [--print] [--json]` | 扫描技术栈、目录、子项目、入口与 CI，生成 `project-overview.md`；重扫只刷新自动段；默认与 `--json` 附带适用性参考（仅静态启发式，不构成结论） |
| `/devflow:status [--slug <slug>] [--json]` | 只读查看进度、产物缺口与下一步命令 |
| `/devflow:upstream [--stage <stage>] [--stack <name>] [--shared] [--all] [--to personal\|team\|upstream] [--pr] [--apply] [--revert <id>] [--force] [--plugin-root <插件源码仓库>] [--personal-library <path>] [--team-library <path>]` | 把项目经验回灌到个人库、团队库或上游插件；`--stack` 回灌单个技术栈，`--all` 包含所有栈；默认只预览，`--apply` 才写入，`team` 加 `--pr` 提交并开 PR |
| `/devflow:ship [--stage <stage>] [--stack <name>] [--shared] [--all] [--profile upstream\|team] [--plugin-root <模板库根>] [--dry-run] [--resume <branch>] [--no-pr]` | 上游回灌后提交到分支、推送并生成 PR；`--no-pr` 只推送不建 PR，`--profile team` 可推到团队库 |
| `/devflow:sync [--dry-run] [--force] [--personal-library <path>] [--team-library <path>]` | 插件升级后按来源优先级同步阶段、共享与技术栈模板，手改内容自动三方合并 |
| `/devflow:stack <add|list|update|restore|remove|status|lock|lint|cache> [...]` | 按需安装、更新、恢复或删除技术栈包；`add` 必须提供 `--repo`、`--from` 或 `DEVFLOW_STACK_REPO`，安装后需在 `hub.yaml` 声明 `stack` |
| `/devflow:clean [--apply] [--hub] [--docs] [--all] [--json]` | 清理工作区里的 devflow 产物；默认只预览，`--hub` 追加删除项目真源，`--docs` 追加删除任务记录，`--all` 两者都删；stack/trash 备份与回灌日志始终保留 |
| `/devflow:change --slug <slug> --from <req\|plan\|test\|review> [--purge] [--apply] [--json]` | 重开阶段：`req` / `plan` 保留该阶段文档供修改、归档下游；`test` / `review` 归档该阶段记录及下游；默认只预览，`--apply` 才移动 |

命令与技能已统一：这些入口实际是 `skills/<name>/SKILL.md`，斜杠调用方式不变。`init` / `onboard` / `upstream` / `ship` / `sync` / `stack` / `clean` / `change` 标了 `disable-model-invocation`，只能由用户显式触发，避免模型自行改写工作区或插件仓库。

已产出的阶段文件就是进度记录：完整任务依次是 `req.md → plan.md → test.md → review.md`，小功能用 `brief.md` 替代前两份，小 bug 从 `debug.md` 开始。不确定当前进度时先运行 `/devflow:status`，它只读扫描 `docs/devflow/`，报告每个任务的阶段、流程类型、缺口和建议的下一步命令，不写任何状态。上游产物比下游新时，`status` 会提示“下游可能过期”，只提示、不改变阶段；需要真正重做时用 `/devflow:change` 把指定阶段及下游归档到 `.archive/`。只有一个任务时工作流命令可省略 slug；存在多个任务时会列出候选，不会替你选择，也不使用 `latest` 兜底。

插件同时提供统一 CLI（`bin/devflow`，安装后命令名为 `devflow`）：

```bash
devflow init
devflow gen
devflow doctor --json
devflow status --json
devflow route --stage plan
devflow route --detect
devflow sync --dry-run
devflow stack add java-spring --repo <url>
devflow stack remove java-spring --keep
devflow clean
devflow clean --hub --docs --apply
devflow change --slug add-login --from plan
devflow change --slug add-login --from req --purge --apply
devflow upstream --shared --to personal --apply
devflow upstream --stack java-spring --to personal --apply
devflow upstream --stage plan --to team --apply
devflow upstream --stage plan --to team --pr --apply
devflow upstream --stage review --to upstream --pr --dry-run
devflow ship --stage review --dry-run
devflow ship --stack java-spring --dry-run
devflow triage --slug add-login --write
devflow triage --slug fix-auth --focus security --agents 2
devflow triage --slug add-login --check
devflow triage --slug add-login --since v1.2.0
devflow triage --escalate
devflow check --stage req --slug add-login
devflow check --stage plan --slug add-login
devflow check --stage implement --slug add-login
devflow check --stage test --slug add-login
devflow check --stage review --slug add-login
devflow check --stage debug --json
devflow trace --slug add-login
devflow trace --slug add-login --check
devflow trace --slug add-login --json
devflow test --gaps
devflow test --changed
devflow test --command "npm test" --exit-code 0 --duration-ms 1200
devflow upstream --revert <id>
```

等价于 `node scripts/<script>.mjs`；参数原样透传，`devflow help` 查看全部命令。阶段入口会自动执行 `devflow route --stage <stage>`，手动运行主要用于排查与脚本集成。

验收标准用验收 ID（`AC-1`、`AC-2`…）串联需求、计划、测试与审查：`plan.md` / `brief.md` 的任务拆分表填写「验收项」列，`test.md` 的「验收覆盖」表按 ID 记录证据，`review.md` 的「验收对照」按 ID 给结论。`devflow trace --slug <slug>` 默认只读输出矩阵与缺口；加 `--check` 时存在未覆盖、未映射或阻断的验收项才退出 1。旧产物没有 AC ID 时按出现顺序推导并给出 warning，不打断已有项目。

## 六个阶段

| 阶段 | 职责 | 关键门禁 |
| --- | --- | --- |
| req | 把模糊诉求变成可验证需求 | 验收标准带唯一 AC ID 且可观察；写明本次不做；影响面具体 |
| plan | 调研已有实现，给出方案、任务拆分、测试策略与回滚 | 引用真实文件；任务可独立验证；验收项列覆盖全部 AC；复用结论有来源；有回滚 |
| implement | 按计划或 `brief.md` 小步实现，优先 TDD | 每步可运行；无无关改动；计划与实际同步；交付前核对验收缺口 |
| test | 真实运行测试并记录证据 | 全量已跑；改动有直接覆盖；验收覆盖按 AC 填证据；未运行不得写通过 |
| review | triage 判定触发与方向，再按风险审查差异 | 无未处理阻断项；验收对照逐条按 AC；敏感信息扫描通过 |
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
| 安装、初始化与第一个任务的最短路径 | [docs/quickstart.md](docs/quickstart.md) |
| 三层结构、目录职责、AI 读取时机、同步与回灌范围 | [docs/layers.md](docs/layers.md) |
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

先清理项目产物，再卸载插件——清理命令由插件提供，卸载后不可用：

```bash
devflow clean                        # 预览
devflow clean --hub --docs --apply   # 确认后执行；按需去掉 --hub / --docs
/plugin uninstall devflow
```

`clean` 会把删除项先移到 `.claude/.devflow-trash/<时间戳>/`，确认无需恢复后手动删除。`.claude/` 下你自己写的其他技能不受影响。`.claude/hub/` 是项目真源、`docs/devflow/` 是任务记录，只有显式加 `--hub` / `--docs` 才会删除。

插件已卸载、只剩残留时，可手动兜底：

```bash
rm -rf .claude/hub .claude/skills/devflow-* .claude/.hub-manifest.json .claude/.hub-sources.json .claude/.hub-bases .claude/.stack-sources.json .claude/.stack-bases .claude/.stack-staging .claude/.devflow-state.json .claude/.ecosystem-state.json scripts/devflow-*.mjs .devflow.json
```

不要手动删除 `.claude/.stack-trash/` 与 `.claude/.devflow-trash/`，它们保存的是可恢复备份。

## 许可

MIT，见 `LICENSE` 与 `.claude-plugin/plugin.json`。
