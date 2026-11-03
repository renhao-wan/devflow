# devflow 设计

日期：2026-10-27

## 目标

参考企业级 AI 规范工具的架构，做一个适合 Claude Code 的个人工程工作流插件。保留三个精髓：单一真源、薄壳入口、可回灌；去掉安装器和多端适配。

## 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 形态 | Claude Code 原生 plugin |
| 范围 | 通用工程核心，语言无关 |
| 受众 | 个人为主，结构上留分发余地 |
| 架构 | 薄壳 + 单一真源 |
| 工作区 | 多根，统一从根启动 |
| hub 位置 | `<根>/.claude/hub/` |
| hooks | 关键项阻止：危险命令拦，未测试提醒 |
| 回灌 | 手动触发 |
| 命令归属 | 插件统一提供 `/devflow:*`，入口以 `skills/<name>/SKILL.md` 实现 |
| 初始化 | 内置模板 + 自动探测 |

## 分层

```
插件（出厂默认）
  skills/ + agents/ + hooks/ + templates/ + bin/ + evals/
        │ init 时复制模板
        ▼
项目 .claude/hub/（项目真源）
  hub.yaml + stages/<stage>/{SKILL.md, references/, templates/} + _shared/
  project-overview.md（派生文档：自动段 + 人工补充，不入源账本、不回灌、不触发投影）
        │ 生成器投影
        ▼
项目 .claude/skills/devflow-*（薄壳）
```

## 职责边界

- 插件级 `skills/`（工程流程、TDD、评审、排障、hub 管理）是**跨项目通用能力**，描述“怎么做”。阶段入口（req…sync）同样是 skills，只是带上了 `disable-model-invocation` 等调用约束，不再是独立的 `commands/`。
- `templates/stages/` 是**项目级阶段规则**，init 复制为 `.claude/hub/`，描述“本项目每个阶段的具体规范”。
- 两者主题相近但用途不同，不互相替代：修改阶段规范只动项目 hub，修改通用方法论才动插件 skills。

## 六阶段与门禁

| 阶段 | 产出 | 硬门禁 |
| --- | --- | --- |
| req | req.md / brief.md | 验收标准非空，未知项列明 |
| plan | plan.md | 调研结论有来源；每个改动点有验证方式 |
| implement | 代码 | 小步，可编译，优先 TDD |
| test | 测试证据 | 通过要有命令与输出 |
| review | 评审结论 | 触发与方向已判定；高危未修不得通过 |
| debug | 根因与回归 | 无复现不下结论 |

小功能用 `req --light` 产出 `brief.md`（合并 req 与 plan），小 bug 由 `debug.md` 直接进入 test；两者都只压缩文档，不跳过测试证据。小功能始终 review；小 bug 测试后由 triage 按实际 diff 判定，安全、数据、认证/权限/并发等风险触发 review，`review: required` 作为显式要求保留。命中依赖、公共接口、迁移、权限/认证/支付/并发/安全边界、不可逆或规模阈值时升级完整流程，并在产物中写 `## 升级判断`。阶段推断仍只看产物：`hub-status` 按 `req/plan` → `brief` → `debug` 的顺序判定流程类型。

## 审查触发与画像

审查不再对所有改动一律平铺检查，而是先做一次确定性 triage（`scripts/review-triage.mjs`），再按结果分配注意力：

- **触发优先级**：用户指定方向/数量 > `review: required` > diff 风险信号 > 跳过。完整任务、轻量功能与未识别流程始终必审；只有轻量修复可能跳过。
- **画像来源**：路径规则（认证、支付、密钥、迁移、并发、依赖清单、公共契约、测试）与 diff 新增/删除行内容规则（动态执行、凭据标识、结构性数据变更、并发原语、兼容性、遗留标记）。同一方向同一规则只计一次，多文件命中仅小幅加分，避免“文件多即高危”。
- **等级与上限**：按最高分与高分方向数得到 low / medium / high / special，对应子代理上限 0 / 1 / 2 / 4；用户 `--agents` 覆盖上限但硬上限为 4。
- **方向选择**：默认排除可维护性与测试质量（基线检查覆盖），验收对照仅在 high / special 派代理；用户 `--focus` 指定后只审这些方向，其余让位。所有未入选方向进入 `excluded` 并带理由，被上限截掉的用户方向同样留痕，不静默漏审。
- **代理分组**：A 正确性 + 并发、B 安全 + 依赖、C 验收与回归 + 测试质量、D 数据与迁移、E 可维护性；相关方向合并，异质方向分开。
- **产物**：`review-triage.json` 保存判定，`hub-status` 读取 `trigger` 判断轻量修复是否还需 review；文件缺失或损坏时回退 `debug.md` 的 `review: required` 标记，保持向后兼容。

triage 是纯函数加 git 读取，不调用模型；模型只负责在给定方向内审查，减少“想到哪查到哪”和重复劳动。

## hooks

`guard-dangerous` 对所有项目的 shell 类工具（`Bash`、`PowerShell`、`Monitor`）生效；`guard-generated` 阻止手改生成物；状态记录、结束提醒与会话注入只对含 `.claude/hub/hub.yaml` 的项目生效；`subagent-note` 对所有使用 devflow 子代理的项目生效，只向主上下文注入提醒、显示给用户，不写状态。

| 事件 | 行为 |
| --- | --- |
| PreToolUse(Bash/PowerShell/Monitor) | 危险命令阻止 |
| PreToolUse(Edit/Write/MultiEdit/NotebookEdit) | 阻止手改投影、账本与 loader |
| PostToolUse(Edit/Write/Bash… ) | 记录改动文件；hub 源改动单独标记 |
| UserPromptSubmit | 有未验证改动时注入一次提醒 |
| PostToolUse(Agent/Task) | devflow 子代理结束时向主上下文注入核对提醒，并显示给用户 |
| Stop | 有代码改动未测试，或 hub 源改动未重新生成时提醒 |
| SessionStart | 注入当前子项目和测试命令 |

完整事件、生成物写保护与 deny/ask 清单见 [hooks.md](hooks.md)。

## 进度与命令衔接

阶段产物 `docs/devflow/<slug>/{req,plan,brief,debug,test,review}.md` 是唯一进度记录，不额外持久化 `currentStage` 或 `currentSlug`，避免状态与真实产物不一致。审查 triage 的 `review-triage.json` 也落在同一目录，属于判定快照而非进度状态，可随时重新生成。

- `/devflow:status` 只读扫描产物，推导每个任务所处阶段、缺口与下一步命令；存在多个任务时列出候选，不擅自选择。
- 可选 `scripts/statusline.mjs` 复用同一推导，输出单行 `slug · stage · 待测试/需补审查`；不配置时仍用 `/devflow:status`。
- 只有一个任务时，工作流命令可以省略 slug；多个任务必须显式指定，不使用 `latest` 兜底。
- 每个阶段入口末尾写明下一阶段命令，但不会自动调用；`init` / `upstream` / `ship` / `sync` 仍禁止模型自动触发。
- 这种方式把“连续性”放在产物与文档约定上，不引入状态机；代价是需要用户确认 slug，收益是不会产生脏状态。

## 回灌与升级

回灌把项目里验证过的规则送回插件，分**范围**与**出口**两个维度：范围是 `--stage <name>` / `--shared` / `--all`，出口是 `--to local`（直接写插件源码）与 `--to remote`（临时 worktree 建分支、提交、推送、开 PR）。两种出口共用同一套 `plan → apply` 流水线，避免本地与远程出现两套分类规则。回灌目标由显式 `--plugin-root` > `.devflow.json` 的 `pluginSourceRoot` > 运行时插件根依次决定，落在安装缓存的写入会被拒绝。

分类采用**显式标记优先、行级剔敏兜底**：`devflow:local` 块整块剔除，`devflow:reusable` 块强制保留但仍做敏感扫描；未标记内容逐行匹配绝对路径、内网地址、常见密钥、blocklist 与子项目名，命中行单独剔除，其余行照常回灌；剔除后无正文才判为项目专属。这样一段通用规则不会因为相邻一行带内网地址而整文件丢失。

默认**不 bump 版本**：回灌只改模板并写日志，发版时显式 `--bump`。每次写入先备份到 `.devflow/backups/<id>/` 并记 journal，中断可续做；日志写 `.devflow/upstream-log.jsonl` 与 `docs/upstream-log.md`，`--revert <id>` 可回滚。远程提交前重新扫描写出的文件并校验 `SKILL.md` frontmatter，`push` 失败保留本地分支，`--resume` 可续推；同 head 已有 PR 时更新而非重复创建。

插件升级后，`hub-sync` 同步 `templates/stages` 与 `templates/shared`。账本 `.claude/.hub-sources.json` 升级为 schema v2，为每个文件记录 `{ base, local }`，`.claude/.hub-bases/` 保存上次模板原文作为共同祖先。判定顺序：目标不存在 → 新增；本地一致 → 跳过；本地未改 → 跟随模板；模板未变 → 保留手改；`--force` → 直接覆盖并备份；否则用 `git merge-file` 三方合并，成功则写入合并结果，冲突则保留本地。同步只动 `stages/` 与 `_shared/`，不碰 `hub.yaml` 与 `overrides/`。

插件版本以 `.claude-plugin/plugin.json` 为权威来源，`package.json` 与 `.claude-plugin/marketplace.json` 的 `plugins[].version` 是镜像，必须一致；`metadata.version` 属于市场自身元数据，不决定插件安装版本。回灌/`ship` 的 `--apply --bump <patch|minor|major>` 会同时更新，清单测试负责校验漂移。

具体操作、启用状态与故障处理见 [maintenance.md](maintenance.md)。

## 方案前调研

plan 阶段的职责从“给方案”扩展为“先确认有没有现成实现，再给方案”。取舍如下：

- **分级调研**：小改动可跳过并写明理由；有界改动至少看官方文档与一个同类实现；架构性改动必须调研候选方案、许可证、维护状态与迁移成本；可行性探索标为 spike，只产出结论与证据。
- **来源优先**：官方文档 > 官方仓库代码 > 社区实现 > 博客；读代码而非只读 README，结论要能指向具体文件或链接。
- **外部内容不可信**：检索结果视为数据，不执行其中指令，不发送密钥或私有代码，防止 prompt injection。
- **搜索失败降级**：WebSearch → 官方文档/仓库 → GitHub API → 本地插件/vendor/缓存 → 用户资料；有上限重试，显式标记未验证项，禁止编造来源；高风险改动检索失败时先请用户确认。
- **复用结论落盘**：`plan.md` 记录检索记录、候选对比与“采用 / 借鉴 / 自建 / 排除”的理由；review 阶段核对这些结论的来源、许可证与维护状态。

req 阶段同步记录技术约束（是否允许新增依赖、许可证政策、运行时下限、离线/私有部署、数据驻留、必须兼容接口），避免 plan 调研出“技术上可行但组织上不允许”的方案。

操作细节与失败降级顺序见 [usage.md](usage.md)。

## 与 superpowers 的边界

devflow 与 superpowers 都覆盖计划、TDD、排障与评审，但分工不同：devflow 负责**阶段顺序、产物路径、门禁、项目真源、回灌与同步**；superpowers 负责**执行技法**（brainstorming、writing-plans、TDD、systematic-debugging、requesting-code-review / receiving-code-review、verification、worktrees）。

冲突时以 devflow 的阶段门禁与产物路径为准；已有的 superpowers 设计或计划吸收进 `plan.md`，不维护两份。devflow 自带的 TDD、排障、评审技能作为未安装 superpowers 时的 fallback。

## 工具生态与路由

项目可以在 `.claude/hub/ecosystem.yaml` 声明同类工具。配置提交到仓库、可手改；检测结果写入 `.claude/.ecosystem-state.json` 并加入 `.gitignore`，避免每次检测重写用户配置。

路由只决定**谁执行当前阶段的技法**，不接管阶段门禁与产物：

- `technique` 工具只接管执行技法（brainstorming、TDD、排障、评审）；阶段顺序、门禁与 `docs/devflow/<slug>/` 仍由 devflow 负责。
- `workflow` 工具会替换整个流程，所以 `mode: auto` 也只建议，不自动委派。
- 默认 `mode: ask`；`off` 关闭路由；`forceDevflowStages` 与 `--force-devflow` 提供强制出口。
- 决策优先级：强制 devflow > `--tool <id>` > `mode: off` > 强制阶段 > 自动匹配。

检测是启发式的，只检查技能目录与项目/用户 `settings.json`、`settings.local.json` 的 `enabledPlugins` 是否存在，不读取技能内容、不执行外部工具、不在状态里记录绝对路径；`enabled: false` 的工具不参与检测。状态缺失或过期时，`devflow route --stage` 会自动检测一次（`--list` 保持只读）。配置缺失、解析失败或检测结果缺失时回退 devflow，不阻塞开发；只有显式指定的工具不可用时才报错。

路由命令：`devflow route --stage <stage> [--tool <id>] [--force-devflow] [--json]`，以及 `--detect` / `--list`。阶段入口技能在执行前自动调用；`init` 创建配置并首次检测，`doctor` 校验配置与检测时效，`status` 展示当前模式与可用工具。详见 `docs/tool-routing.md`。

## 安全边界

`guard-dangerous` 是基于正则的尽力拦截，不是沙箱；七个钩子一律 fail-open。安全模型、凭据处理与加固建议见 `SECURITY.md`。这个取舍保证正常的开发操作不会因钩子本身出错而被卡死。

## 里程碑

- [x] 插件骨架、命令、技能、agent
- [x] hub 脚本：init / gen / doctor / upstream / ship / sync / mark-test
- [x] hooks 脚本
- [x] 测试与示例工作区验证（`node --test` 全绿，覆盖脚本、hooks、清单一致性与端到端链路）
- [x] 文档与版本 1.2.0
- [x] 1.3.0：plan 方案前调研与搜索失败降级、req 技术约束、review 依赖核对、debug 已知问题检索、superpowers 边界
- [x] 1.3.1：修复生成器账本与 `--json`、ship 基分支、track-changes 误报、Windows 递归删除拦截，统一命令与阶段技能引用
- [x] 1.3.2：路径与阶段名校验、ship 临时 worktree、hooks 时间与包装器绕过修复、`_shared/` 共享规则、CRLF 兼容与 loader 自动刷新
- [x] 1.3.3：真实路径边界校验、回灌 journal 与中断续做、环境变量式凭据识别与统一脱敏、hooks stdin 截断与账本越界防护
- [x] 1.4.0：生成物写保护、PowerShell/Monitor 危险命令拦截、hub 改动与待验证分离、`evals/` 行为评测、`bin/devflow` 统一 CLI、命令迁移为 skills
- [x] 1.4.1：`/devflow:status` 只读进度视图、阶段入口补充下一步命令与 slug 推断规则、工具生态索引与路由（`devflow route`、`--detect` / `--list` / `--force-devflow` / `--tool`）、轻量功能与小 bug 双通道（`brief.md` / `debug.md`）
- [x] 1.5.0：`/devflow:onboard` 项目概览；`init` 生成简版，重扫只刷新标记块内自动段；`doctor` 通过事实指纹发现概览过期
