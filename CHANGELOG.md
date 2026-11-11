# Changelog

## 1.8.0

### 增强

- 新增 `devflow change` / `/devflow:change`：按阶段归档及下游产物到 `docs/devflow/<slug>/.archive/<时间戳>/`，默认只预览，`--apply` 才移动；`--purge` 支持连起点文档一起归档，重开后按剩余产物推导阶段
- 新增归档查看与恢复：`change --list` 只读列出归档与 manifest；`change --restore <归档目录名|latest>` 默认预览，`--apply` 恢复。只接受 manifest 白名单产物，目标已存在时默认整体拒绝，`--force` 覆盖前先备份到 `replaced-<时间戳>/`，失败逆序回滚
- 上游产物比下游新时，`status`、`statusline` 与阶段门禁提示“下游可能过期”，并给出可执行的预览归档起点；多条过期只推荐链上最早一条，`test` 晚于 `review` 时只归档旧审查，不连带刚更新的测试记录
- 新增 `status --ack`：把整条链的过期指纹写入 `.devflow-state.json`，不移动产物；产物再变化时确认自动失效，同时抑制 status、statusline、check 与会话启动提示
- `SessionStart` 钩子注入未确认的下游过期摘要，最多展开 3 个任务，只提示、不自动归档
- `status` 检测标题规范化后相同的多个任务并提示合并，避免同一需求维护两套 slug 与产物
- `change`、`restore` 使用任务锁串行化并发操作，`manifest.json` 原子写入；未传 `--root` 时从子目录向上查找项目根

### 修复

- 修复 `--from req --purge` 未归档其他流程残留入口产物（如完整任务里的 `debug.md`）导致任务被重新识别为轻量流程的问题
- 修复 `status --json` 缺少 `slugs[].title`，导致 req 阶段无法按文档判断重复任务的问题
- 修复恢复过程中目标存在、备份失败或归档损坏时的清理与回滚边界，并补充缺失/损坏 manifest 的单项降级
- 修复轻量流程 plan/implement 阶段错误承诺过期 warning 的文档表述；这两个阶段没有更早的链上产物，只在实际影响当前阶段输入时提示

### 变更

- 插件版本升至 `1.8.0`；测试补充阶段回退与归档恢复、过期检测与确认失效、会话启动提示、并发归档与状态文件损坏等回归用例

## 1.7.0

### 增强

- 新增审查触发与风险画像：`devflow review-triage` 先做确定性 triage，再按触发来源（用户指定、`review: required`、diff 风险信号）与风险等级（low / medium / high / special）分配审查方向与子代理上限；未入选方向进入 `excluded`，未派单方向进入 `deferred`，不静默漏审
- review 门禁读取 `review-triage.json`，`--check` 校验结论、未关闭阻断项与画像一致性；支持 `--since <ref>` 增量复审并强制补「增量复审」小节，锚点必须是 HEAD 祖先，rebase 后不可达时直接报错；轻量流程用 `--escalate` 复用同一套风险画像
- 新增验收追踪：req 的验收项带 AC ID，plan 任务表、test 验收覆盖与 review 验收对照按 ID 关联；`devflow trace --slug <slug>` 合并为矩阵并列出缺口，`--check` 在未覆盖、未映射或阻断时退出 1，`status` 同步展示验收缺口
- 新增 req / debug 结构门禁 `devflow check --stage req|debug`；test 新增 `--gaps`（改了源码但没有测试痕迹）与 `--changed`（可能受影响的已存在测试）；`mark-test` 记录退出码与耗时，失败保留待测试标记且不覆盖上次通过时间
- `status` 把计划声明文件与实际 diff 对照，提示计划外改动与计划未改动文件；审查 triage、测试覆盖与验收追踪统一复用这些结果，不额外持久化进度状态
- 完善第二层规则读取：阶段入口先读项目投影，投影只记录 `_shared/`、`overrides/` 与 `stacks/` 的路径并按需读取正文；新增技术栈数据模型，按 stack 惰性读取并接入 `sync`、`upstream`、`ship`、`doctor` 与 SessionStart 摘要
- `init` 生成可编辑的规则草稿：`_shared/project-basics.md` 与单一技术栈的 `stacks/<stack>/_shared.md`；单一技术栈自动写入 `hub.yaml` 的 `stack`，多栈不猜；Makefile 作为辅助栈，避免 Node.js 项目被误判为多栈
- 新增 `devflow-rule-placement` 技能，按影响范围判断规则应落在 `_shared/`、阶段、技术栈还是子项目覆盖；六个阶段入口接入落位提示
- 草稿标记与生命周期统一：首行 `<!-- devflow:draft -->` 未删除时不进入投影、`sync` 不覆盖、`upstream` 不回灌、`doctor` 以 INFO 提示；`gen` 统计未启用草稿并在 JSON 报告输出 `drafts`
- `init` 支持 `--draft` 显式触发技能层补全，`--no-draft` 关闭草稿与自动 `stack`，两者互斥；默认只生成占位草稿，可直接进入 `/devflow:req`
- 回灌扩展为「范围 × 出口」：范围支持 `--stage`、`--stack`、`--shared`、`--all`，出口支持个人库、团队库与上游插件；默认只预览，加 `--apply` 才写入，团队库与上游可加 `--pr` 走临时 worktree 建 PR
- 回灌写入前备份并记录 journal，支持中断续做、`.devflow/upstream-log.jsonl` / `docs/upstream-log.md` 日志与 `--revert <id>` 回滚；远程提交前重新扫描密钥并校验 `SKILL.md` frontmatter，推送失败保留本地分支，`--resume` 可续推
- 模板同步支持 `templates.order` 多来源合并（团队 > 个人 > 上游），账本升级为 schema v3，为每个文件记录 `{ base, local, source }`；本地与模板都改过时用 `git merge-file` 三方合并，高优先库删除文件后自动回落
- `doctor` 新增 `--mode auto|plugin|project`：插件源码仓库自动进入插件模式，校验版本一致性、hooks、CLI 脚本、六阶段模板与技能 frontmatter；新增 INFO 级别，不计入提醒与建议
- `doctor` 建议按类型排序并合并重复项，`init` 类建议合并为一条；插件模式不再输出项目工作区建议
- `status` 按未初始化、已初始化无任务、有任务分三态展示首屏，未初始化时只给入口引导；未配置路由合并为一行，JSON 报告新增 `initialized`
- `init` 先写 loader、投影与账本再生成项目概览，概览精确排除 devflow loader 的 `scripts/`，避免刚初始化就显示过期；loader 清单抽到 `scripts/lib/loaders.mjs`，init、doctor 与 sync 共用
- CLI 命令表下沉 `scripts/lib/cli-commands.mjs`，`bin/devflow` 与 `doctor` 共用；统一未知参数提示、JSON 模式日志标签与 INFO 大写格式
- 加固安全与 hooks 边界：修复路径穿越、分支校验与敏感信息剔除；命令守卫补齐 ANSI-C 参数、SQL 重定向、heredoc、嵌套 shell 与 PowerShell 删除等绕过面；生成物保护覆盖新增 loader 与账本

### 修复

- 修复高优先模板库删除同名文件后仍保留旧来源、`--force` 覆盖顺序与草稿来源选择错误的问题
- 修复模板三库合并时的覆盖、续做校验与路径边界问题；修复 Windows 短名路径导致模板库嵌套校验漏判
- 修复 `mark-test` 把已删除文件算作测试覆盖证据的问题
- 修复 YAML 解析器静默误读配置、`stages` 空数组被误判、非法配置提示不明确的问题
- 修复 slug 推断、工具启用与计划文件路径判定的边界问题
- 修复 hooks 在 SQL 重定向、heredoc、ANSI-C 参数等场景下的误报与漏报
- 修复审查 triage 在项目内的调用路径与触发方向判定，避免轻量修复被误判为必审或跳过
- 修复否定型 eval grader 误伤正确回答的问题
- 修复 `status` 读取产物与统计改动时对缺失、损坏输入不够健壮的问题
- 修复文档与实现不一致的描述，对齐技能参数契约与升级自检

### 变更

- `init` 默认只生成占位草稿，不再自动补全；需要智能补全时显式使用 `/devflow:init --draft`，最小上手路径变为 `init → req`
- 规则草稿待填写从提醒降为 INFO，不阻断 `gen` / `doctor`，也不计入建议
- `status` 未初始化与未配置路由时的首屏提示收敛，减少初始化前不可用的信息
- 新增 `docs/quickstart.md`，README 与 `docs/README.md` 增加安装 → 初始化 → 第一个任务的最短路径入口；同步更新 `usage`、`maintenance`、`value-and-limits` 与 `development`
- 插件版本升至 `1.7.0`；测试补充草稿、status 三态、doctor 模式矩阵、审查 triage、验收追踪、模板兼容与安全边界等回归用例

## 1.6.0

### 增强

- 回灌统一为「范围 × 出口」：范围支持 `--stage <name>`、`--stack <name>`、`--shared`、`--all`；出口支持 `--to personal`、`--to team`、`--to upstream`。默认只预览，加 `--apply` 才写入；团队库与上游可加 `--pr` 走临时 worktree 建分支、提交、推送并创建/更新 PR；`ship` 复用同一 `plan → apply` 流水线
- 新增共享规则回灌：`.claude/hub/_shared/` ↔ `templates/shared/`；`init`、`sync`、`upstream`、`ship` 均覆盖共享模板
- 支持显式分区标记 `devflow:reusable` / `devflow:local`；未标记内容改为行级剔敏，命中敏感模式的行单独剔除，其余内容仍可回灌，剔除后无正文才判为项目专属
- 回灌默认不改版本文件与 CHANGELOG；`--apply` 只写模板与回灌日志，发版由维护者按独立流程处理
- 写入前备份到 `.devflow/backups/<id>/` 并记录 journal，中断后重跑可续做；新增回灌日志 `.devflow/upstream-log.jsonl` 与 `docs/upstream-log.md`，支持 `--revert <id>` 回滚
- `ship` 新增 `--remote`、`--pr-repo`、`--fork`、`--resume`、`--no-pr`；同 head 已有开启中 PR 时更新标题与正文，不再重复创建；提交前重新校验 `SKILL.md` frontmatter 与疑似密钥
- 插件升级同步升级为三方合并：账本 schema v3 为每个文件记录 `{ base, local, source }`，`.claude/.hub-bases/` 保存模板基线，通过 `git merge-file` 自动合并；`--force` 覆盖前仍生成 `.bak` 备份
- `ship` 白名单新增 `templates/shared/`、`.devflow/upstream-log.jsonl`、`docs/upstream-log.md`；推送与错误信息对 URL 凭据和查询参数 token 打码

### 修复

- `ship` 原先在主工作区计算回灌计划却写入临时 worktree；现在基于 worktree 重新计算，主工作区与当前分支完全不受影响
- `git status` 未展开未跟踪目录，导致 `.devflow/`、`docs/` 被误报为白名单外文件
- `--all` 在项目没有 `_shared` 目录时误报缺少共享规则
- 子项目名与 blocklist 对 ASCII 名称按词边界匹配（`api` 不再命中 `rapid` / `capital`），中文等非 ASCII 名称按包含匹配
- 预览阶段即校验目标库与回灌范围；备份遇到目录时跳过，避免 `EPERM`

## 1.5.0

### 增强

- 新增 `/devflow:onboard` 与 `devflow onboard`：扫描技术栈、顶层目录、子项目、入口与 CI，生成 `.claude/hub/project-overview.md`；`init` 生成简版，重扫只刷新标记块内自动段，保留人工补充
- 概览自动段记录结构指纹，`doctor` 可发现过期或缺失；`init` 在旧工作区补生成概览
- 入口扫描覆盖子项目、Java `*Application.java` / `*Main.java` 与 Go `cmd/*/main.go`；技术栈识别与子项目发现共用构建签名表
- SessionStart 注入概览摘要；req/plan 先读概览定位，再以代码与 `hub.yaml` 为准

### 修复

- 概览写入前校验 `.claude/hub` 真实路径，拒绝通过 junction/符号链接写到项目外
- 概览内容未变时不重写文件、不刷新时间戳；重扫统一行尾并处理残缺标记块
- `onboard` 校验 `--root` 并让 `--print`/`--json` 互斥，默认输出补充扫描摘要
- 项目概览更新不再触发阶段投影重新生成

## 1.4.1

### 增强

- 接入 Claude Code 原生能力：关键决策使用 `AskUserQuestion` 并保留文本降级；子代理引用统一为 `devflow:devflow-*`，同时保留 `Task`/裸名兼容说明
- implement、test、debug 提供可选 `/goal` 完成条件模板，明确 goal 不替代门禁；plan 接入 plan mode 与 `Plan`/`Explore` 子代理，debug 支持并行假设验证，review 高风险时支持双视角子代理交叉审查
- 子代理按职责设置模型：`test-runner` 使用 `haiku`，reviewer 与 debug-investigator 使用 `inherit`；删除 `model` 行即可回退默认模型
- review 阶段与内置审查命令协作：`/code-review` 可选，`/security-review`、`/ultrareview` 外发前必须确认，`/simplify` 应用修改后回到 implement 并重新 test
- 新增可选 `scripts/statusline.mjs` 与 `devflow statusline`，复用 `hub-status` 推导输出单行进度；README 提供 `statusLine` 配置
- 新增 `UserPromptSubmit` 与 `PostToolUse(Agent/Task)` hooks：未验证改动提醒与子代理结论核对提示，均 fail-open、从不阻止
- 新增只读 `devflow:devflow-plan-research` 技能，使用 `context: fork` 与 `disallowed-tools` 禁用写工具；plan 阶段优先引用
- 新增 `docs/native-capabilities.md`，记录能力矩阵、版本要求、命名与降级边界；`docs/tool-routing.md` 说明 MCP 不自动检测、需手动登记
- implement/debug 与 README 补充 `/rewind`、`/worktree` 使用建议，并提示 `/rewind` 会丢弃当前会话改动
- 新增轻量流程：小功能用 `/devflow:req --light` 产出 `brief.md`（合并需求与计划），小 bug 由 `/devflow:debug` 直接产出 `debug.md`；只压缩文档、不跳过测试，小功能保留 review，小 bug 按风险补审
- `hub-status` 识别 `brief.md` 与 `debug.md`：显示「轻量功能 / 轻量修复」及下一步；独立 `debug.md` 不再被误判为 req
- 小 bug 按风险补审查：`debug.md` 顶部的 `review: required` 用于不触发升级的安全、数据、认证/权限/并发风险，测试通过后提示 `/devflow:review`；公共接口、迁移与依赖必须升级完整流程
- 轻量流程显式升级：新增依赖、公共接口/契约、数据结构/迁移、不可逆操作，或非测试/文档改动 >200 行 / >10 文件 / >2 子项目时，写 `## 升级判断` 并补 `req.md` / `plan.md`；80–200 行或 5–10 文件先询问。计数口径统一为 `git diff --numstat`，排除 `docs/devflow/**`、测试文件、lockfile 与生成物
- 新增 `brief.template.md` 与 `debug-report.template.md`（正确行为依据、改动范围、回归证据、现成实现检索、升级判断）
- req、debug、implement、test、review 阶段与入口技能同步轻量输入、验收来源优先级、升级判断核对、slug 去重与零候选提示；`hub-status` 文本对风险修复提示「需补审查」，`needsReview` 兼容引号与 CRLF
- `req --light` 不切换 workflow 工具：入口附加 `--force-devflow`，与 `--tool <id>` 同时出现时轻量优先；`debug` 轻量仍可委派 `technique` 排障技法，但 `debug.md` 是唯一产物
- 新增只读 `/devflow:status`（及 `devflow status`）：扫描 `docs/devflow/` 的产物，推导各任务所处阶段、缺口与下一步命令，不写入任何状态
- 阶段入口补充下一步命令提示；统一 slug 推断规则：只有一个候选时自动采用，多个候选时列出让用户选择，不再回落到 `latest`
- 新增工具生态索引与路由：`.claude/hub/ecosystem.yaml` 登记同类工具，`devflow route --stage <stage>` 返回 `use-devflow` / `suggest` / `delegate`；支持 `--detect`、`--list`、`--tool <id>` 与 `--force-devflow`
- 路由只委派执行技法：`technique` 工具可被 `auto` 自动委派，`workflow` 工具只建议；阶段顺序、门禁与 `docs/devflow/<slug>/` 产物仍由 devflow 负责
- `init` 自动创建生态索引并检测；检测结果写入 `.claude/.ecosystem-state.json` 并加入 `.gitignore`，与可提交配置分离
- `doctor` 校验生态配置、检测结果缺失/过期；`status` 展示路由模式与可用工具；`load-hub` 在 SessionStart 注入路由摘要
- 六个阶段入口接入路由步骤，`argument-hint` 支持 `--force-devflow`；新增项目内 `scripts/devflow-route.mjs` loader
- `guard-generated` 保护 `devflow-route.mjs` 与 `.claude/.ecosystem-state.json`
- 检测结果缺失或过期时，`devflow route --stage` 自动检测一次后再决策，避免新克隆项目首次进入阶段总是回退；`--list` 保持只读
- `enabled: false` 的工具不参与检测，也不出现在 SessionStart 注入的可用工具中
- `--detect` 可与 `--stage` / `--list` 组合，组合命令的 stdout 始终只有一份 JSON
- 终端反馈改进：`hub-status` 每个任务分行展示阶段、产物与下一步；`hub-doctor` 按告警类型给出具体建议，不再统一提示重新生成；`hub-sync` 遇冲突后提示手工合并或 `--force`（会备份）；缺失 hub 配置时提示先运行 `/devflow:init`
- 六个阶段入口统一报告实际 slug 与 `docs/devflow/<slug>/` 路径，下一步命令使用实际 slug，避免用户猜测占位符
- README 同步五个 loader、`devflow-route` 生成物与快速开始中的 `/devflow:status` 确认步骤

### 修复

- 修复阶段入口缺少 `Skill` 权限导致无法委派路由候选工具的问题（req、test 补齐，六个入口统一 `delegate` / `error` 处理）
- 修复多行 `note` 渲染为 YAML 时破坏配置结构的问题
- 路由错误结果统一包含 `constraints`，避免调用方读取空字段
- `hub-status` 在完整流程只有 `review.md`、缺少 `test.md` 时回到 test，避免无测试证据却判定完成
- hooks 状态写入统一加锁并原子替换，锁残留与超时后降级；`track-changes` 忽略账本自身的锁与临时文件，`git status` 增加超时与输出上限；`check-tests` 在已测试或投影已生成时清零对应提醒
- `guard-dangerous` 支持 `git -C <dir> push`、引号命令名、`xargs`/`find -exec` 嵌套 shell 与 PowerShell `Remove-Item -Recurse` 盘符根；放行 `man mkfs`、`Get-Help Format-Volume` 等帮助查询
- `guard-generated` 在无 `hub.yaml` 的项目中不介入，修正生成阶段索引与状态账本提示
- `hub-init` / `hub-sync` 校验 `requiresPlugin`、限制写入项目内路径、逐步持久化账本并在中断后自愈；manifest 只记录与插件模板一致的文件。`hub-doctor` 区分缺失与损坏的 `.devflow.json` / 账本；生态检测补充用户 `settings.local.json`
- `argValue` 不再把后续开关当成参数值；`findPluginRoot` 优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`
- 修正两处 eval grader：否定式正确回答（“不要直接修改”）不再被误判为违规
- statusline 多任务时不再擅自选第一个任务，`--json` 输出 `activeSlug: null` 与完整任务列表；根目录支持向上查找，长行优先截断 slug 以保留阶段；改用同步写出并支持 `devflow statusline` CLI 分发
- 子代理核对提醒改由 `PostToolUse(Agent/Task)` 向主上下文注入，同时保留用户可见提示与旧载荷兼容；不再依赖只作用于子代理自身的 `SubagentStop.additionalContext`
- `plan`、`implement` 阶段补回 `Task` 工具权限，`Agent` 不可用时仍可委派子代理
- `/goal` 文案改为提示用户自行运行，明确插件不会自动设置 goal
- plan-research 技能统一使用 `devflow:devflow-plan-research` 命名空间，避免裸名解析失败
- `hub-doctor` 校验 `hooks.json` 必需事件与脚本注册，安装不完整时给出明确告警
- `prompt-reminder` 在无未验证改动或本轮已提醒时跳过状态写回，避免每次提交 prompt 都重写状态文件

### 测试

- 新增 `tests/status.test.mjs`，覆盖无任务、单任务推断、完成态、多任务不擅自选择与 `--slug` 过滤
- 状态测试补充轻量功能与轻量修复的 implement/test/review/done 分支、`review: required` 风险标记与完整流程优先级
- 新增 `tests/route.test.mjs`，覆盖 22 种路由决策：未配置回退、mode、ask/auto、强制与指定工具、阶段不匹配、forceDevflowStages、检测与插件键、检测结果缺失时自动检测、禁用工具不参与检测、`--detect` 与阶段/列表组合、解析失败 fail-open、`--list`、非法阶段名、检测名路径穿越与默认配置渲染往返
- 更新 CLI、端到端、状态视图、模板约定与 hooks 测试，覆盖 `route` 命令、生态配置生成、入口路由步骤、禁用工具过滤与检测状态保护
- 补充完整流程“review 早于 test”回归、`argValue` 不吞开关、eval grader 不误伤否定式回答，以及 git 全局选项/引号命令名、嵌套 shell、PowerShell 盘符删除与磁盘帮助命令的 hooks 用例
- 补充 UX 回归：`status` 多行输出、`doctor` 按类型建议、`sync` 冲突后续操作、入口技能报告实际 slug、`loadHub` 初始化提示
- 新增 `tests/native.test.mjs`，覆盖结构化提问、子代理命名、goal/plan mode/并行审查、模型字段、内置审查命令、只读调研技能与文档降级说明
- 新增 `tests/statusline.test.mjs`，覆盖单行输出、stdin 根推导、无任务与只读不写状态，以及多任务 JSON、多任务全局标记、子目录根推导、长 slug 保留阶段与 CLI 分发
- hooks 测试补充 `prompt-reminder` 的一次性提醒与 `subagent-note` 的已知/未知子代理分支，并覆盖 `PostToolUse(Agent/Task)` 注入主上下文、旧载荷与 JSON 字符串 `tool_input`
- 补充 `prompt-reminder` 无操作时不重写状态文件、`hub-doctor` 校验 hooks 事件与脚本注册的回归用例
- 新增 `tests/docs.test.mjs`，校验 README 与 `docs/` 的相对链接、文档索引覆盖率与 README 关键入口

### 文档

- README 精简为定位、特性、安装、快速开始、命令、阶段概览与文档入口；阶段与配置、hooks、维护、开发细节拆到 `docs/` 主题文档
- 新增 `docs/README.md` 文档索引，并新增 `docs/usage.md`、`docs/hooks.md`、`docs/maintenance.md`、`docs/development.md`
- 新增 `docs/comparison.md`，对比 devflow 与 BMAD、cc-spec-driven、Spec Workflow、OpenSpec、ucai、Spec Kit、superpowers 的定位、重叠与优缺点
- 新增 `docs/value-and-limits.md`，说明适用人群、当前限制与真实项目验证方法
- 新增 `docs/tool-routing.md`，说明配置、检测范围、决策优先级、命令、安全边界与 fail-open 行为
- README、设计文档、对比、价值与限制、SECURITY、CHANGELOG 同步更新工具路由说明
- 同步文档中的测试数、五个 loader、`settings.local.json` 检测范围、CI 清单校验与轻量流程升级触发项

## 1.4.0

### 增强

- 新增 `guard-generated` 钩子：编辑 `.claude/skills/devflow-*` 投影、`.claude/.hub-manifest.json`、`.claude/.hub-sources.json`、`.devflow.json` 与 `scripts/devflow-*.mjs` loader 时直接拒绝，避免生成物与账本漂移
- `guard-dangerous` 从仅 `Bash` 扩展到 `PowerShell` 与 `Monitor`，覆盖 Windows 终端与后台监控命令
- `track-changes` 区分流程数据与业务改动：`docs/devflow/**` 完全忽略，`.claude/hub/**` 标记为 hub 改动；`check-tests` 在 hub 源改动未重新生成投影时提醒，但不再计为测试待验证
- 新增 `bin/devflow` 统一 CLI，`devflow <init|gen|doctor|sync|upstream|ship|test>` 参数透传给对应脚本
- 阶段入口由 `commands/*.md` 迁移为 `skills/<name>/SKILL.md`，调用方式不变；`init` / `upstream` / `ship` / `sync` 禁止模型自动调用
- 新增 `evals/` 行为评测用例（阶段路由、生成物保护、危险命令拒绝），`claude plugin eval` 仍为 early access，用例结构由测试校验
- `.claude-plugin/plugin.json` 与 marketplace 条目补充 `homepage` / `repository` 元数据

### 文档

- README 更新目录结构、hooks 事件、生成物写保护、CLI、评测用法与版本号
- `docs/design.md` 更新分层与 hooks 表，补充 1.4.0 里程碑
- `SECURITY.md` 更新支持版本、shell 类工具覆盖范围与 `guard-generated` 边界说明

### 测试

- 回归测试增至 143 项，新增 PowerShell / Monitor 拦截、生成物写保护、hub 改动分流、CLI 与评测用例结构等用例

## 1.3.3

### 修复

- 边界不变量：`hub-upstream`、`hub-sync`、`hub-init` 与生成器统一按真实路径校验，拒绝 junction / 符号链接把写入带到项目或插件目录之外；Maven `<module>` 指向工作区外时跳过
- 失败原子性：`hub-upstream` 新增回灌 journal，在文件复制、版本升级、CHANGELOG 写入之间中断后重跑可续做；版本文件无法解析时直接报错而不是半途退出；`writeAtomic` 与 hooks 的 JSON 写入在 `finally` 中清理临时文件
- 外发内容控制：密钥检测覆盖未加引号的环境变量式赋值（如 `DB_PASSWORD=...`、`AWS_SECRET_ACCESS_KEY=...`、`MYSQL_ROOT_PASSWORD: ...`），`ship` / `upstream` 的日志与错误统一脱敏；`guard-dangerous` 补充环境变量与 `--token` 形式的凭据脱敏
- hooks：stdin 未在超时内读完时改为 `ask`，不再静默放行；`load-hub` 跳过账本中的越界条目，CRLF 差异不再误报漂移；`track-changes` / `check-tests` 改用并发安全的原子写入
- `ship` 的版本基线取自 `--base` 分支，避免把当前分支的预发布版本带进回灌 PR

### 测试

- 回归测试增至 131 项，新增 junction 越界、回灌中断恢复、损坏版本文件、stdin 截断、CRLF 漂移、环境变量式密钥与凭据脱敏等用例

## 1.3.2

### 修复

- `hub-upstream` / `hub-ship` 校验阶段名并做路径包含性检查，防止通过 `hub.yaml` 或账本把文件写到 `.claude/hub/stages` 与插件模板之外
- 生成器与 `doctor` 解析账本路径时使用真实路径校验，跳过符号链接，并把 Windows 与 POSIX 的行尾差异归一化后再比较哈希
- `hub-ship` 改用临时 git worktree 完成回灌、提交与推送，主工作区不切换分支；`--base` 在写文件前校验，push 失败时保留本地分支与提交
- `track-changes` 修复 `Date.parse` 缺失时间时的 1999 年回退，记录 rename 的旧路径，并支持 `NotebookEdit` 的 `notebook_path`
- `check-tests` 对缺失或非法时间字段按“未知”处理，不再因时间回退而漏提醒或误静默
- `guard-dangerous` 识别换行分隔的复合命令、环境变量前缀与 `sudo -u` / `timeout` / `env` / `nice` 等包装器，以及 `cmd.exe /c`、`cmd //c`、`powershell -C`、`shutdown.exe`、`rd /s/q`、`Remove-Item -Rec` 等变体；拒绝原因中的 URL 凭据、token 与密码参数会脱敏
- `init` 重跑时自动刷新过期的 loader，且 loader 加载顺序优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`
- `hub-sync` 兼容旧账本记录的原始哈希，仅行尾不同时不再误判为手改
- `doctor` 校验 `.claude/hub/_shared/` 的路径与哈希，发现共享规则变更时提示重新生成；测试状态同时参考 `testsPending` 与改动时间

### 增强

- 新增跨阶段共享规则目录 `.claude/hub/_shared/`，生成器会把其中每条规则注入所有阶段投影并记入账本
- 命令的 `allowed-tools` 补齐 `Task` / `Skill`；review 命令与相关技能改用 superpowers 的实际技能名 `requesting-code-review` / `receiving-code-review`
- 测试报告模板新增运行环境字段（OS / Node / 包管理器）

### 文档

- README 更新 loader 顺序、`_shared/`、ship 的临时 worktree 安全约束、CI Node 20 / 22 与测试数量
- `docs/design.md` 补充 1.3.2 里程碑

## 1.3.1

### 修复

- 生成器只把实际写入的投影记入账本；源文件出错时保留旧账本条目，过期清理跳过出错阶段，避免投影失去归属后被误删
- 非受管投影内容与生成结果一致时正常采用；内容不同时跳过并提示 `--force`，不再静默覆盖或写入账本
- `--json` 普通执行时 stdout 只输出报告，过程日志改走 stderr，便于脚本解析
- `init` / `sync` 在生成阶段出错时明确提示错误数量，不再把失败包装成“初始化/同步完成”
- `ship` 从 `--base`（本地或 `origin/<base>`）创建分支，避免把当前分支的无关提交带进 PR；远端 URL 日志做脱敏
- `track-changes` 用修改时间筛选 Bash 后的 `git status`，已有脏文件或只读命令不再误触发“测试待验证”
- `guard-dangerous` 覆盖 Windows 非根递归删除（`rd /s`、`del /s`、`Remove-Item -Recurse`），按命令位置判断避免误伤 `echo` / `grep` 文本；盘符根仍直接拒绝
- `hub-upstream` 在 CHANGELOG 标题缺失时补标题再插入；已有同版本条目时不重复写入

### 文档

- 命令入口标注“以下为入口摘要，与阶段 SKILL 冲突时以 SKILL 为准”，并补齐 TDD、测试执行、系统排障、代码审查技能与子代理引用
- plan 阶段明确吸收 superpowers 的 `brainstorming` / `writing-plans` 结论，不并存两份设计或计划
- 三个 fallback 技能补充与 superpowers 的关系说明
- README 更新 hooks 事件、Windows 递归删除的 deny/ask 说明与版本号

## 1.3.0

### 增强

- plan 阶段新增“先调研已有实现”：按小改动 / 有界 / 架构性 / 可行性探索分级决定调研深度；产出 `## 调研与复用判断`，记录检索记录、候选对比与“采用 / 借鉴 / 自建 / 排除”的理由
- 新增 `templates/stages/plan/references/prior-art-research.md`：检索方法、候选评估维度（能力、许可证、维护状态、依赖与退出成本、安全合规、迁移成本）与结论分类
- plan 新增搜索失败降级协议：WebSearch → 官方文档/仓库 → GitHub API → 本地插件/vendor/缓存 → 用户资料；有上限重试，显式标记未验证项，禁止编造来源；高风险改动检索失败时先请用户确认
- req 新增“技术约束”：是否允许新增依赖、许可证政策、运行时/版本下限、离线或私有部署、数据驻留、必须兼容接口；产出模板新增 `## 技术约束`
- review 新增“复用与依赖检查”：核对 plan 的复用判断来源、许可证与约束一致性、维护状态与已知漏洞、搜索失败披露；`review-checklist` 新增对应清单
- debug 新增可选的“查已知问题”：用完整错误、错误码与依赖版本检索官方 issue 与变更日志；外部结论只作线索，须本地复现验证
- `commands/plan|review|debug` 的 `allowed-tools` 补充 `WebSearch`、`WebFetch`；plan 额外补充 `Bash(gh:*)`；`devflow-code-reviewer`、`devflow-debug-investigator` 子代理同步获得检索能力
- `devflow-engineering-flow` 新增“与 superpowers 的协作边界”：devflow 管阶段与门禁，superpowers 管执行技法，冲突以 devflow 为准，已有计划吸收进 `plan.md`

### 文档

- README 新增“方案调研与搜索失败处理”“与 superpowers 的关系”章节，六阶段表更新 plan 门禁
- `docs/design.md` 新增方案前调研决策、superpowers 边界与 1.3.0 里程碑
- `SECURITY.md` 新增“外部调研”安全说明：外部内容不可信、不外发敏感信息、许可证以原文为准、网络调用不受 guard 保护；支持范围更新至 1.3.x

## 1.2.1

### 修复

- `guard-dangerous` 改为引号感知的分词与命令位置匹配：`git commit -m "fix reboot"`、`grep "shutdown"`、`echo "DROP DATABASE"`、`rg "format C:"`、`rm -rf ./build`、`rm -rf ~/work/tmp` 不再误拦；根目录判断只匹配精确的 `/`、`~`、`.`、`..`
- `guard-dangerous` 递归检查 `bash/sh/zsh -c`、`pwsh -Command`、`cmd /c`、`eval`、`xargs rm`、`find -exec rm`，补上 `bash -c 'rm -rf /'`、`xargs rm -rf` 等绕过
- `guard-dangerous` 的 SQL 规则只作用于 `psql` / `mysql` / `sqlcmd` 等客户端通过 `-c` / `-e` / `-Q` 传入的语句
- `track-changes` 覆盖 `Bash` 与 `NotebookEdit`：Bash 通过 `git status --porcelain` 发现 `sed -i`、格式化器、代码生成等间接改动，并过滤 `node_modules`、`dist`、`build`、`coverage` 等噪声
- `track-changes` 在 Windows 跨盘符时再次判断绝对路径，避免把项目外文件计入
- `check-tests` 同一批改动只提醒一次，减少 Stop 时重复刷屏

### 增强

- 版本模型改为 `plugin.json` 权威、`package.json` 与 `marketplace.plugins[].version` 镜像；`metadata.version` 不再作为插件版本来源，`hub-upstream` 同步写入 `plugins[].version`
- `hub-upstream` 新增密钥/凭据扫描（`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xox*-`、私钥、`Bearer`、URL 凭据、`password=` 等），命中按项目专属处理且不回显原文；补充 `127.0.0.1`、`169.254/16`
- `hub-doctor` 检查 `.devflow.json` 记录的插件版本，落后时提示 `/devflow:sync`；新增阶段资源清单摘要
- `review` 阶段增加“验收对照”，逐条核对 `req.md` 验收标准与 `plan.md` 任务；review 模板新增验收对照表
- `debug` 阶段增加结论字段 `fixed` / `partial` / `unresolved`，非 `fixed` 必须写明残余风险
- `load-hub` 返回 `reloadSkills`，`/clear`、resume 后重新扫描投影；PostToolUse 增加 `NotebookEdit`，SessionStart 增加 `fork`
- 命令文档补齐 `--bump`、`--no-pr`、`--no-gen`、`--plugin-root`；`ship` 白名单说明补全 `package.json` 与 `marketplace.json`
- `engines.node` 与 README 统一为 `>= 20.11`
- 流程说明把 `debug` 画成 `test` / `implement` 的失败分支，而不是 `review` 之后的必经阶段

### 测试与 CI

- 新增 guard 误伤/嵌套、SQL 客户端、Bash 改动追踪、check-tests 节流、回灌密钥扫描、marketplace 条目版本等用例
- CI 新增插件清单校验作业：`claude plugin validate . --strict`、`claude plugin validate .claude-plugin/plugin.json --strict`、`claude plugin tag --dry-run`

## 1.2.0

### 修复

- `upstream` 子项目名与 blocklist 改为词边界匹配，`api` 不再误伤 `rapid` / `capital`；中文等非 ASCII 名称仍按普通包含处理
- 生成物（`.bak-*`、`.tmp-*`、隐藏文件）不再进入阶段资源、回灌候选与 `sync` 复制，避免把备份内容带进插件模板
- `guard-dangerous` 修复绕过：递归强制删除改为选项顺序无关并支持 `--recursive` / `--force` 等长选项；补充 `git clean --force`、`git branch --delete --force`、`git push origin +main`、`git push origin :main`
- 生成器校验阶段名（小写字母开头的 `[a-z0-9_-]`）并对投影写入做路径越界防护，拒绝写出 `.claude/skills/devflow-*` 之外的位置

### 增强

- 版本号统一种子为三处单一真源：`.claude-plugin/plugin.json`、`package.json`、`.claude-plugin/marketplace.json` 的 `metadata.version`；`upstream --apply` 与 `ship` 同时更新，新增清单一致性测试
- `upstream` / `ship` 新增 `--bump patch|minor|major`；内容与插件一致时不再重复 bump 或写 CHANGELOG
- `ship` 白名单补充 `package.json` 与 `.claude-plugin/marketplace.json`；分支名去重同时检查本地与 `origin`；push 失败时切回执行前的分支
- `hub-init` 把四个 loader 写入 `.gitignore`，并用标记块幂等更新，重复 init 不再叠加；loader 加载顺序为 `pluginRoot → pluginSourceRoot → CLAUDE_PLUGIN_ROOT`
- `hub-doctor` 新增检查：`hub.yaml` 的 `version` / 阶段名合法性 / 重复阶段 / blocklist 类型、`testCommand` 的 `cd` 目标与 `./gradlew` 等本地脚本是否存在、`.gitignore` 片段与 loader 完整性
- `hub-sync` 应用后刷新 `.devflow.json` 的 `pluginRoot` 与 `pluginVersion`，并过滤生成物
- `implement` 命令补充常用构建/测试工具到 `allowed-tools`
- `mark-test` 记录通过后清空 `testsPending`；`track-changes` 忽略账本与生成元数据
- 抽取 `scripts/lib/common.mjs` 的 `canonicalPath` / `samePath` / `isGeneratedArtifact` / `bumpVersion`，hooks 共用 `hooks/scripts/lib.mjs`，`load-hub` 复用 YAML 解析器
- 删除未使用的 `templates/hub.yaml`

### 测试与 CI

- 测试增至 77 项，新增清单一致性、guard 等价写法、回灌幂等与版本同步、PR 正文、loader 回退、生成物过滤等用例
- CI 新增 `syntax` 作业（Node 18/22 下 `node --check` 全部脚本并解析 JSON），`smoke` 覆盖 Linux 与 Windows

### 文档

- 新增 `SECURITY.md`：支持范围、漏洞报告渠道、信任模型、`guard-dangerous` 的局限与凭据处理
- README 与 `docs/design.md` 同步更新 loader 策略、doctor 检查、`--bump`、版本单一真源、ship 白名单、CI 说明

## 1.1.0

- 新增 `/devflow:sync` 与 `scripts/hub-sync.mjs`：插件升级后非破坏性同步阶段模板。未手改的文件更新，手改过的文件跳过并报告冲突，`--force` 覆盖前生成 `.bak-<时间戳>` 备份
- 新增 `.claude/.hub-sources.json` 源文件账本：记录 init/sync 落盘时的文件哈希，用于区分“未改可更新”与“手改需保留”
- 新增 `pluginSourceRoot`：`/devflow:init --source-root <插件源码仓库>` 记录回灌目标，运行时插件根与回灌目标解耦
- 回灌与 ship 拒绝写入 marketplace 安装缓存（`plugins/cache/...`），避免升级后结果丢失；插件根解析在缓存失效时优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`
- Maven 多模块：init 解析父 `pom.xml` 的 `<modules>` 并展开为独立子项目（最多两层），测试命令为 `cd <模块> && mvn test`
- `doctor` 新增 `testCommand` 依赖工具检查（npm / pnpm / yarn / bun / mvn / gradle / go / cargo / dotnet / pytest 等），缺失时提示
- `ship` 生成的 PR 正文改用仓库 PR 模板结构
- 安全门禁补充 Windows 磁盘与影子副本操作（`diskpart`、`cipher /w`、`vssadmin delete shadows`、`Format-Volume` 等），以及 Git 历史重写（`update-ref -d`、`filter-branch`、`push --mirror`、`reflog expire`）的确认
- 新增 `LICENSE`（MIT）与 `package.json`（`engines.node >= 18`、`npm test`）
- 新增 PR 模板：统一变更类型、验证清单与影响面说明
- 修正 `ship` 在 Windows 上的仓库根目录判断：用 realpath 归一化 8.3 短路径与分隔符，避免 `git rev-parse --show-toplevel` 与 `--plugin-root` 字面不一致
- 修正 CI 与文档中的测试命令：改用 `node --test`，避免 Node 22 把目录参数当作模块路径导致 `MODULE_NOT_FOUND`
- 新增 GitHub Actions：Node 20/22 跨平台运行测试，并执行 init → gen → doctor 冒烟
- 新增 `/devflow:ship`：回灌后创建分支、提交、推送并生成 PR，支持 `gh`、GitHub API（`GITHUB_TOKEN`）与 compare 链接三种方式
- 阶段目录支持 `references/` 与 `templates/` 资源：随 init 复制、写入投影与生成账本、doctor 校验、回灌递归处理
- 子项目测试命令从工作区根生成，支持 `packageManager` 与 lockfile 探测
- hooks 自身异常时放行；扩展危险命令规则（强推保护分支、Windows 盘符根删除等）
- 生成器清理账本中已移除阶段的过期投影
- 修正文档中的安装方式与 hooks 作用域说明
- 文档补充 init 探测边界：含 `.git`/构建文件的目录会停止下钻，深层子项目（如容器仓库内的模块）需手动修正 `hub.yaml`；根无构建文件时 `defaults.testCommand` 回退为 `npm test`

## 1.0.0

- 初始版本：六阶段工作流（req / plan / implement / test / review / debug）
- 项目级 `.claude/hub/` 单一真源与薄壳投影
- 多根工作区支持（含 `services/api` 两层探测），统一从工作区根启动
- 关键项 hooks：系统级破坏命令阻止，丢数据风险操作要求确认，未测试提醒
- 五个通用技能、三个子代理、评审/测试/排障参考清单
- 手动回灌与版本兼容检查
- 初始化、生成、体检、回灌、测试标记五个脚本
