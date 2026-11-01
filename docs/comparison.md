# devflow 与同类 Claude Code 工作流插件对比

日期：2026-11-01

本文对比 devflow 与社区中常见的 Claude Code 工作流方案，重点回答三个问题：

1. 它们和 devflow 是否重复；
2. 各自的优点与缺点；
3. devflow 应该保持什么定位，哪些能力值得借鉴、哪些不应引入。

外部项目迭代较快，本文结论以撰写时公开的 README 与文档为准；实际选型前建议复核最新版本。

## 对比范围

| 类别 | 对象 |
| --- | --- |
| 规格驱动工作流 | GitHub Spec Kit、BMAD-METHOD、OpenSpec、Claude Code Spec Workflow（Pimzino） |
| 状态机/强约束工作流 | cc-spec-driven |
| 原生插件式工作流 | ucai |
| 执行技法技能集 | superpowers |
| 编排模式 | 社区状态机 / orchestrator 方案（Nick Tune、MindStudio） |
| 本文主体 | devflow |

## 结论先行

**在“阶段流程”这一层，devflow 与多数同类项目高度重叠；在“项目级真源与维护机制”这一层，devflow 有明显差异。**

重叠的部分：

- `req → plan → implement → test → review` 的阶段划分，与 Spec Kit、BMAD、Spec Workflow、ucai、cc-spec-driven 基本同构。
- “阶段产物落盘，下一阶段读取产物”的做法，与 OpenSpec、cc-spec-driven、Spec Workflow 一致。
- 进度查询功能，与 BMAD 的 `bmad status` / `bmad-help`、cc-spec-driven 的 `/dd-status`、Spec Workflow 的 `/spec-status` 属于同类。

不重复的部分：

- **项目级单一真源**：`.claude/hub/` 是项目规则源，生成 `.claude/skills/devflow-*` 薄投影；多数同类项目直接维护命令或技能模板，没有“源 → 投影”的生成链。
- **非破坏性同步与回灌**：`sync` 保留本地手改，`upstream` 把项目改进回灌插件模板。
- **多根工作区与测试命令探测**：自动识别 `services/api` 这类子项目并生成测试命令。
- **失败开放的安全钩子**：危险命令拦截、生成物写保护、测试提醒，钩子自身异常时不阻塞开发。
- **零运行时依赖**：不依赖 MCP server 或外部 CLI。

因此，devflow 不应再扩展成另一个 BMAD 或 Spec Workflow；它的价值在“项目流程与规则维护层”，而不是“最多命令”或“最强自动化”。

## 能力对比

| 能力 | devflow | BMAD | cc-spec-driven | Spec Workflow | OpenSpec | ucai | Spec Kit | superpowers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 多阶段流程 | 六阶段 | 可伸缩工作流 | 规格变更流程 | 需求→设计→任务→实现 | 变更提案→归档 | init→plan→build→iterate→review | 规格→计划→任务→实现 | 不负责 |
| 产物落盘 | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 由技能自行约定 |
| 显式状态机 | 无 | 无（有帮助/状态入口） | 有 | 部分（任务状态） | 部分（变更生命周期） | 规格链 | 部分（任务清单） | 无 |
| 进度查询 | `/devflow:status`（只读推导） | `bmad status` / `bmad-help` | `/dd-status` | `/spec-status` | `continue` / `verify` | 规格链加载 | 任务清单 | 无 |
| 项目级规则真源 | 有（`.claude/hub/`） | 技能/模块 | 项目文件 | 模板/命令 | 规格文件 | PRD/规格 | 模板/命令 | 无 |
| 非破坏性升级 | 有（`sync`） | 安装/更新技能 | 无统一机制 | 无统一机制 | 无统一机制 | 无统一机制 | 部分（模板更新） | 无 |
| 回灌到公共模板 | 有（`upstream` / `ship`） | 可贡献模块 | 无 | 无 | 无 | 无 | 通过扩展/贡献 | 无 |
| 钩子强制 | 有（fail-open） | 无核心强制 | 有（阻止式） | 有限 | 有限 | 有限 | 有限 | 无 |
| 外部依赖 | 无 | 安装技能 | 无 | MCP 版依赖 server | CLI | 无 | 需安装工具 | 无 |
| 自动化程度 | 手动/模型按意图调用 | 中 | 高约束、手动触发 | 一条命令可全流程 | 中 | 中高 | 中 | 技法层 |
| 生态规模 | 小 | 大 | 小 | 中 | 中 | 小 | 大 | 大 |

## 逐项优缺点

### devflow

定位：项目级工程流程 + 规则真源 + 非破坏性维护。

优点：

- 阶段门禁明确，每个阶段有产物和检查项。
- `.claude/hub/` 为单一真源，生成薄投影，避免规则散落。
- `sync` 保留本地手改，`upstream` 回灌项目改进，适合长期维护自己的流程。
- 支持多根工作区、子项目测试命令探测与 Maven 多模块展开。
- 安全钩子明确 fail-open，不会因为钩子故障卡死开发。
- 零运行时依赖，安装与升级成本低。
- 新增只读 `/devflow:status`，不引入可变状态就能回答“做到哪、下一步做什么”。

缺点：

- 阶段切换仍靠用户或模型按流程执行，没有自动编排。
- `status` 是启发式推导，不是精确状态机。
- `testsPending` 是全局状态，多任务并行时归因有限。
- 生态、模板与社区规模较小。
- 门禁执行依赖模型遵守技能说明，缺少强制阻断。

### BMAD-METHOD

定位：可伸缩的敏捷 AI 开发方法，覆盖从构思到实现的工作流与模块。

优点：

- 能从周末小项目扩展到复杂系统，流程可裁剪。
- `bmad-help` / `bmad status` 直接回答下一步与可选动作。
- 模块化、生态大，决策与上下文强调显式保存。
- 允许“从任意阶段开始”，不强迫所有项目走完整流程。

缺点：

- 体系重、模块多，学习和维护成本高。
- 不是项目规则生成器，没有 devflow 式的真源、投影与回灌。
- 技能面大，小改动容易显得流程过重。
- 自动化依赖模型遵循工作流说明，强约束有限。

### cc-spec-driven

定位：用文件状态机管理规格变更。

优点：

- 状态 `draft → confirmed → done/dropped` 明确。
- `/dd-status` 根据当前状态推荐下一步动作。
- hooks 强制“只能这样做”，状态推进与文件写入绑定。
- 提供 RC 预览、一致性检查与冲突处理，可追溯性强。

缺点：

- 非常刚性，小改动也要走完整状态流转。
- 状态推进依赖文件写入，绕过文件即可失效。
- 阻止式 hooks 与 fail-open 取舍冲突，容易卡住正常开发。
- 命令与产物较多，维护成本高于收益的场景很多。

### Claude Code Spec Workflow（Pimzino）

定位：一条命令完成需求、设计、任务拆分，并提供任务执行与状态查看。

优点：

- `/spec-create` 降低启动成本，适合快速进入结构化开发。
- `/spec-execute` 保留逐任务手动执行能力。
- `/spec-status` 查看进度，专用 agents 协作。
- MCP 版本提供实时 dashboard，可视化程度高。

缺点：

- 每阶段控制感较弱，自动生成内容需要人工复核。
- 自动生成大量 task 命令，命令面容易膨胀。
- MCP/dashboard 增加运行依赖与部署成本。
- 项目处于早期并已转向 MCP 版本，稳定性需自行评估。

### OpenSpec

定位：以变更提案与归档为中心的规格工作流。

优点：

- `propose → archive` 清晰表达“为什么改、改了什么”。
- `continue` / `ff` / `verify` 支持续做、快速推进与校验。
- 跨 30+ AI 助手，可移植性较好。
- 规格与变更分离，长期追溯友好。

缺点：

- 扩展 profile 后命令数量明显增加。
- 规格维护成本高，简单改动容易过度记录。
- TDD、代码审查、系统排障不是核心能力。
- 没有项目级规则生成、非破坏同步与回灌。

### ucai

定位：用 Claude Code 原生插件实现结构化工作流。

优点：

- `/init → /plan → /build → /iterate → /review` 路径直观。
- 每个阶段边界有确认门禁，强调人在回路。
- 按 feature 保存 PRD，自动加载规格链。
- 原生插件、零依赖，安装简单。

缺点：

- 仍偏早期，能力与生态有限。
- 核心阶段与 devflow 高度重叠。
- 没有多根工作区、测试命令探测、规则同步与回灌。
- 插件自身的维护工具链较少。

### GitHub Spec Kit

定位：提供结构化流程、可复用模板与文档化产出的工具包。

优点：

- 规格 → 计划 → 任务 → 实现的路径清晰，容易理解与推广。
- 模板与扩展生态成熟，适合组织级标准化。
- 与多种 AI 编码工具配合，采用面广。

缺点：

- 偏模板与命令集合，执行约束与安全门禁较弱。
- 需要项目自行定制模板与命令。
- 没有项目级单一真源、非破坏性同步与回灌。
- 流程开销对小改动偏高。

### superpowers

定位：执行技法技能集，覆盖 brainstorming、计划、TDD、系统排障、代码评审等。

优点：

- 技法成熟，适合直接提升单步执行质量。
- 跨项目通用，不绑定具体项目结构。
- 与 devflow 的阶段门禁可以互补。

缺点：

- 不负责阶段顺序、产物路径、门禁与进度。
- 单独使用时容易出现“有技法、没流程”。
- 与 devflow 在 TDD、评审、排障主题上重叠，需要明确边界。

### 社区状态机 / orchestrator 模式

代表：Nick Tune 的会话状态机、MindStudio 的编排器方案。

优点：

- 衔接确定性强，可把多个技能自动串成端到端流程。
- 状态文件或 orchestrator 让“当前进度”显式可见。
- 适合批量、重复、可预测的任务。

缺点：

- 状态管理是链式工作流最常见的失败点。
- 需要额外 hooks、状态同步与失败恢复，维护成本高。
- 容易变成阻塞式流程，违背 fail-open 取舍。
- 对个人或小团队通常是过度设计。

## devflow 的定位建议

1. **保持差异化**：做项目级流程与规则真源，不追求阶段数量、命令数量或全自动编排。
2. **保留只读进度视图**：`/devflow:status` 已能回答“做到哪、下一步做什么”，不需要再引入 `currentStage` / `currentSlug` 持久状态。
3. **不引入阻塞式状态机**：状态机带来的确定性，不足以抵消状态漂移、钩子阻塞与维护成本。
4. **不复制 dashboard / MCP server / 大量 agent**：这些是其他项目的优势，不是 devflow 的核心问题。
5. **明确互补关系**：
   - 执行技法用 superpowers；
   - 重型规格管理用 BMAD / OpenSpec / Spec Kit；
   - devflow 负责项目规则、阶段门禁、同步与回灌；
   - 同一个仓库不要让两个框架同时充当流程主控，否则产物与门禁会冲突。

## 何时选择其他方案

| 需求 | 更适合的方案 |
| --- | --- |
| 想要一条命令跑完整个规格流程 | Spec Workflow（Pimzino） |
| 想要强状态机与硬性状态流转 | cc-spec-driven |
| 想要大型模块化方法论与社区生态 | BMAD-METHOD |
| 想要轻量的变更提案与归档 | OpenSpec |
| 想要组织级模板标准化 | GitHub Spec Kit |
| 只需要执行技法，不需要项目流程 | superpowers |
| 需要项目级规则真源、同步与回灌 | devflow |

## 来源

- [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
- [cc-spec-driven](https://github.com/mkhrdev/cc-spec-driven)
- [Claude Code Spec Workflow](https://github.com/Pimzino/claude-code-spec-workflow)
- [Spec Workflow MCP](https://github.com/Pimzino/spec-workflow-mcp)
- [OpenSpec](https://github.com/Fission-AI/OpenSpec)
- [GitHub Spec Kit](https://github.com/github/spec-kit)
- [ucai 讨论（Reddit）](https://www.reddit.com/r/ClaudeCode/comments/1r5b8rf/built_a_plugin_that_adds_structured_workflows_to)
- [Claude Code Skill Collaboration: Chaining Workflows（MindStudio）](https://www.mindstudio.ai/blog/claude-code-skill-collaboration-chaining-workflows)
- [Minimalist Claude Code Task Management Workflow（Nick Tune）](https://medium.com/nick-tune-tech-strategy-blog/minimalist-claude-code-task-management-workflow-7b7bdcbc4cc1)
- [Superpowers](https://github.com/obra/superpowers)
