# 分层与扩展点

日期：2026-11-04

本文回答四个问题：

1. devflow 的三层是什么；
2. `.claude/hub/` 里每个目录干什么；
3. AI 在什么时候读取哪一份规则；
4. 同步与回灌分别把内容送到哪里。

> **状态说明**
>
> `stages/`、`_shared/`、`overrides/`、`stacks/` 均已实现：入口先读项目投影，投影内联 `_shared/`、列出 `overrides/` 与 `stacks/` 映射；`stacks/` 参与同步、回灌与 `doctor` 校验。

## 1. 三层是什么

```
第 1 层：插件（安装包）
  skills/ + agents/ + hooks/ + templates/ + scripts/ + bin/ + evals/
        │
        │ /devflow:init 或 /devflow:sync
        │ 把启用的模板库合并后复制到项目
        ▼
第 2 层：项目真源 .claude/hub/
  hub.yaml
  stages/<stage>/{SKILL.md, references/, templates/}
  _shared/
  overrides/
  stacks/
  project-overview.md
        │
        │ node scripts/devflow-gen.mjs
        │ 生成薄投影
        ▼
第 3 层：生成物 .claude/skills/devflow-*
  devflow-req/、devflow-plan/、devflow-implement/ ...
  以及 .claude/.hub-manifest.json 等账本
```

### 第 1 层：插件

| 项 | 说明 |
| --- | --- |
| 位置 | Claude Code 插件目录（marketplace 安装缓存或本机源码仓库） |
| 谁生成 | 插件发布者；你升级插件时更新 |
| 能否手改 | 不要直接改安装缓存，升级会覆盖 |
| 作用 | 提供 `/devflow:*` 入口、默认阶段模板、脚本、hooks、子代理与评测用例 |

它回答的是：**devflow 这个工具本身怎么工作。**

### 第 2 层：项目真源

| 项 | 说明 |
| --- | --- |
| 位置 | 项目根目录的 `.claude/hub/` |
| 谁生成 | `/devflow:init` 首次创建；之后由 `/devflow:sync` 更新 |
| 能否手改 | **可以，而且应该只改这里** |
| 作用 | 定义这个项目每个阶段怎么做、有哪些全局规则、子项目例外和技术栈规范 |

它回答的是：**这个项目自己的流程规则是什么。**

### 第 3 层：生成物

| 项 | 说明 |
| --- | --- |
| 位置 | `.claude/skills/devflow-*/SKILL.md`、`.claude/.hub-manifest.json` 等 |
| 谁生成 | `devflow-gen` 从第 2 层生成；`init` / `sync` 会自动调用 |
| 能否手改 | **不能**，`guard-generated` 会阻止；改了也会在下次生成时被覆盖 |
| 作用 | 把第 2 层的规则包装成 Claude Code 能加载的技能，并记录哈希用于漂移检测 |

它回答的是：**AI 实际加载的入口长什么样。**

### 三层的关系

- 第 1 层是“出厂默认”，第 2 层是“项目定制”，第 3 层是“给 AI 用的出口”。
- 改规则只改第 2 层，然后重新生成第 3 层。
- 第 1 层的 `templates/` 只是第 2 层的来源之一；`init` 之后，项目以第 2 层为准。
- 没有第 2 层时，阶段命令会提示先运行 `/devflow:init`。

## 2. 第二层目录：每个目录干什么

### 2.1 `stages/`

```
.claude/hub/stages/
├─ req/
│  ├─ SKILL.md
│  └─ templates/
├─ plan/
│  ├─ SKILL.md
│  ├─ references/
│  └─ templates/
├─ implement/
├─ test/
├─ review/
└─ debug/
```

| 项 | 说明 |
| --- | --- |
| 装什么 | 每个阶段的做事步骤、门禁、产出要求，以及可选的细则和产出骨架 |
| 谁创建 | `init` 从模板库复制；默认包含六个阶段 |
| 是否手动写 | 通常只改 `SKILL.md`，或在 `references/`、`templates/` 下增删文件 |
| 何时读取 | 进入对应阶段时读取 `SKILL.md`；`references/`、`templates/` 按需读取 |
| 同步 | 会，从个人库、团队库或上游库同步 |
| 回灌 | 会，可回灌到个人库、团队库或上游插件 |

`references/` 与 `templates/` 是 `stages/` 的附属文件：

- `references/`：细则，例如调研方法、审查严重度说明、测试证据要求；
- `templates/`：产出骨架，例如 `req.template.md`、`review.template.md`。

### 2.2 `_shared/`

| 项 | 说明 |
| --- | --- |
| 装什么 | 所有阶段都要遵守的规则，例如安全底线、提交约定、通用错误处理 |
| 谁创建 | `init` 创建目录；默认只有 `.gitkeep`，内容由你添加 |
| 何时读取 | 生成投影时被**内联**进每个阶段投影，随着投影一起进入上下文 |
| 同步 | 会，对应模板库的 `templates/shared/` |
| 回灌 | 会，`/devflow:upstream --shared` |

注意：`_shared/` **不是**在会话启动时读取，也不是在阶段执行时单独读取；它在 `devflow-gen` 运行时被拼进投影正文。

### 2.3 `overrides/`

```
.claude/hub/overrides/
├─ api/
│  ├─ implement.md
│  └─ review.md
└─ web/
   └─ implement.md
```

| 项 | 说明 |
| --- | --- |
| 装什么 | 只对某个子项目生效的例外规则 |
| 谁创建 | `init` 只创建空目录；子目录和文件由你手动创建 |
| 何时读取 | 生成投影时写入“处理 `<子项目>` 时优先读取”的指令；实际读取靠 AI 遵守指令 |
| 同步 | **不会**，`sync` 从不改 `overrides/` |
| 回灌 | **不会**，`upstream` 不处理 `overrides/` |

只写差异，不要整份复制技术栈规范：

```md
# overrides/legacy-api/implement.md

- 本模块继续使用旧 ORM，不适用 Java 栈规范里的新 ORM 约定。
- 其余规范不变。
```

### 2.4 `stacks/`

按语言或框架存放规范，供同一技术栈的多个子项目复用，而不是把同一份规则复制到每个 `overrides/<sub>/`。

```
.claude/hub/stacks/
├─ java-spring/
│  ├─ _shared.md      # 该栈对所有阶段生效（可选）
│  ├─ plan.md         # 该栈在 plan 阶段的规范（可选）
│  ├─ implement.md
│  ├─ test.md
│  ├─ review.md
│  └─ references/     # 可选，由上面的文件按相对路径引用
└─ vue3/
   ├─ _shared.md
   ├─ implement.md
   └─ review.md
```

| 项 | 说明 |
| --- | --- |
| 装什么 | 某个语言/框架在通用与各阶段的编码规范 |
| 谁创建 | `init` 创建空目录；内容由个人库、团队库同步，或项目自己添加 |
| 何时读取 | 生成投影时写入“子项目 → 栈 → 规范文件”映射；阶段执行时只读任务涉及的子项目对应文件 |
| 同步 | 会，对应模板库的 `templates/stacks/` |
| 回灌 | 会，`--stack <name>` 或 `--all` |

映射方式（`hub.yaml` 两级声明）：

```yaml
stack: java-spring          # 工作区默认栈；没有子项目时直接用它

subprojects:
  api:
    path: services/api
    stack: java-spring      # 覆盖默认栈
  web:
    path: apps/web
    stack: vue3
```

规则：

1. 子项目未写 `stack` 时继承顶层 `stack`；没有子项目时使用顶层 `stack` 生成一条“工作区根”映射。
2. 栈名只允许 `[a-z0-9][a-z0-9_-]*`。
3. 被引用的栈目录必须存在；`_shared.md` 与 `<stage>.md` 都可选。
4. 投影只记录文件路径，不内联正文。改栈文件内容不需要重新生成；新增/删除栈文件或改 `hub.yaml` 才需要重新生成。
5. 栈目录存在但没有任何 `.md` 时给提醒，不阻断生成；栈目录缺失、栈名非法或 `stack` 不是字符串都是配置错误，`gen` 与 `doctor` 会报错。报错时 `gen` 仍会写出带「缺失」「名称非法」或「配置无效」标记的投影与账本，但退出码为 1。
6. 子项目省略或留空 `stack` 都会继承顶层 `stack`；当前不支持子项目显式退出继承。个别子项目需要不同规范时，给它指定另一个栈。

### 2.5 `hub.yaml`

| 项 | 说明 |
| --- | --- |
| 装什么 | 默认技术栈、子项目列表、路径、适用阶段、测试命令、模板来源顺序、插件版本要求 |
| 谁创建 | `init` 自动探测生成，需要人工复核测试命令 |
| 是否手动写 | 是，尤其 `testCommand`、`subprojects.stages` 与 `stack` |
| 同步 | **不会**，`sync` 不碰 `hub.yaml` |
| 回灌 | **不会**，`upstream` 不碰 `hub.yaml` |

主要内容：

```yaml
stack: java-spring

subprojects:
  api:
    path: services/api
    stack: java-spring
    stages: [req, plan, implement, test, review]

defaults:
  testCommand: "npm test"

templates:
  order: [team, personal, upstream]
```

### 2.6 `project-overview.md`

| 项 | 说明 |
| --- | --- |
| 装什么 | 项目结构、技术栈、入口、子项目等概览；自动段 + 人工补充段 |
| 谁创建 | `init` 或 `/devflow:onboard` 生成 |
| 何时读取 | 会话启动注入一行摘要；`req`、`plan` 定位时读取 |
| 同步 | **不会** |
| 回灌 | **不会** |

它是派生文档，不是规则真源；以代码和 `hub.yaml` 为准。

### 2.7 `ecosystem.yaml`

| 项 | 说明 |
| --- | --- |
| 装什么 | 同类工具索引与路由模式，例如 superpowers、BMAD、Spec Kit |
| 谁创建 | `init` 创建默认配置 |
| 何时读取 | 阶段入口运行 `hub-route.mjs` 时读取 |
| 同步 | **不会** |
| 回灌 | **不会** |

### 2.8 账本与本机状态

| 文件 | 作用 | 是否提交 |
| --- | --- | --- |
| `.claude/.hub-manifest.json` | 投影哈希、资源清单与技术栈映射，用于漂移检测 | 是 |
| `.claude/.hub-sources.json` | 每个模板文件的来源与基线，schema v3 | 是 |
| `.claude/.hub-bases/` | 三方合并用的基线快照 | 是 |
| `.claude/.devflow-state.json` | 最近一次测试结果 | 是 |
| `.claude/.ecosystem-state.json` | 工具检测结果 | 通常忽略 |
| `.devflow.json` | 本机插件路径与个人/团队库路径 | 通常忽略 |

这些是状态文件，不是规则文件，不要手改。

## 3. AI 什么时候读取

### 3.1 设计意图

```
① 会话启动
   只加载技能元数据（name + description）
   注入 hub 摘要（阶段、子项目、技术栈、投影漂移）
   不读取任何阶段正文

② 用户进入阶段
   /devflow:plan
     → 加载项目投影 devflow-plan
     → 投影内联 _shared
     → 投影要求读取 .claude/hub/stages/plan/SKILL.md
     → 投影列出阶段资源与子项目覆盖

③ 执行阶段
   按需读取 references/、templates/
   处理某个子项目时读取 overrides/<sub>/<stage>.md
   再读取 stacks/<stack>/<stage>.md 与 stacks/<stack>/_shared.md

④ 技术栈规范
   按投影中的“子项目 → 栈 → 规范文件”映射表读取
   只读任务涉及的子项目，不预读全部
```

### 3.2 完整读取链

`/devflow:<stage>` 的实际行为是：

1. **会话启动**：`load-hub.mjs` 注入摘要（阶段、子项目、技术栈、投影漂移），并返回 `reloadSkills: true`；不读取模板正文。
2. **进入阶段**：加载插件入口 `skills/<stage>/SKILL.md`。
3. **入口先读项目投影** `.claude/skills/devflow-<stage>/SKILL.md`。
   - 投影内联 `_shared/`；
   - 投影列出 `overrides/<sub>/<stage>.md`；
   - 投影给出“子项目 → 栈 → 本阶段规范/通用规范”映射。
4. **按投影指令读取 hub 源** `.claude/hub/stages/<stage>/SKILL.md`。
5. **执行阶段**按需读取该阶段的 `references/`、`templates/`；处理子项目时再惰性读取 `overrides/` 与 `stacks/`。

缺失时的回退：

| 情况 | 行为 |
| --- | --- |
| 投影缺失 | 入口直接读 hub 源，并提示运行 `node scripts/devflow-gen.mjs` |
| 投影与 hub 源都缺失 | 提示先运行 `/devflow:init` |

### 3.3 阶段内还会加载什么

除了阶段规则，阶段可能按需使用：

- 子技能：`devflow-plan-research`、`devflow-tdd`、`devflow-code-review`、`devflow-systematic-debugging`；
- 子代理：`devflow-test-runner`、`devflow-code-reviewer`、`devflow-debug-investigator`；
- 外部技法：通过 `hub-route.mjs` 委派给 superpowers 等已安装工具。

这些是“执行方法”，不是“阶段规则”；门禁与产物仍以 devflow 阶段规则为准。

## 4. 冲突与优先级

四个扩展点回答的是不同问题：

| 目录 | 回答的问题 |
| --- | --- |
| `stages/` | 这个阶段做什么、产出什么、过什么门禁 |
| `_shared/` | 所有阶段都必须遵守什么 |
| `overrides/` | 这个子项目有什么例外 |
| `stacks/` | 这个语言或框架的代码该怎么写 |

### 4.1 三条约定

1. **一条规则只放一个家。** 不要在两处重复同一条规则。
2. **越具体越优先。** 先看子项目例外，再看技术栈，再看全局，最后看阶段默认做法。
3. **门禁只能加严，不能放宽。** 技术栈规范和子项目例外都不能取消阶段门禁或安全底线。

### 4.2 优先级

```
阶段门禁与安全底线（最高，不可放宽）
  ↓
overrides/<sub>/<stage>.md（子项目例外）
  ↓
stacks/<stack>/<stage>.md（技术栈规范）
  ↓
stacks/<stack>/_shared.md（技术栈通用规则）
  ↓
_shared/（全局通用规则）
  ↓
stages/<stage>/SKILL.md 中非门禁的默认做法（最低）
```

以上顺序是确定性读取顺序，由投影中的指令约束；生成器与 `doctor` 负责校验映射，不做内容级自动合并。

### 4.3 常见例子

| 规则 | 应该放哪 |
| --- | --- |
| 所有阶段都要写中文提交信息 | `_shared/` |
| Java 类名与分层约定 | `stacks/java-spring/` |
| Vue 组件使用组合式 API | `stacks/vue3/` |
| legacy 模块允许选项式 API | `overrides/legacy-web/` |
| review 必须有测试证据 | `stages/review/SKILL.md`，技术栈不得放宽 |
| plan 的方案结构 | `stages/plan/SKILL.md`，技术栈不得改产出结构 |

## 5. 同步与回灌

### 5.1 两个方向

```
个人库 / 团队库 / 上游库
        │  init / sync：库 → 项目
        ▼
项目 .claude/hub/
        │  gen：项目 → 投影
        ▼
.claude/skills/devflow-*

项目 .claude/hub/
        │  upstream / ship：项目 → 库
        ▼
个人库 / 团队库 / 上游库
```

### 5.2 同步：库 → 项目

`init` 和 `sync` 会按 `hub.yaml` 的 `templates.order` 读取启用的库，把模板落到项目：

| 内容 | 是否同步 | 说明 |
| --- | --- | --- |
| `stages/` | 是 | 对应库里的 `templates/stages/` |
| `_shared/` | 是 | 对应库里的 `templates/shared/` |
| `stacks/` | 是 | 对应库里的 `templates/stacks/` |
| `hub.yaml` | 否 | 项目配置，由 `init` 生成 |
| `overrides/` | 否 | 项目专属例外 |
| `project-overview.md` | 否 | 派生文档 |
| `ecosystem.yaml` | 否 | 项目级工具索引 |

默认来源顺序是团队 > 个人 > 上游（未启用团队库时个人 > 上游），上游兜底。项目里的手改由基线快照做三方合并保留。

### 5.3 回灌：项目 → 库

回灌的“范围”和“目标库”是两个独立维度。

| 维度 | 取值 | 去向 |
| --- | --- | --- |
| 范围 | `--stage <name>` | `.claude/hub/stages/<name>/` → `templates/stages/<name>/` |
| 范围 | `--shared` | `.claude/hub/_shared/` → `templates/shared/` |
| 范围 | `--stack <name>` | `.claude/hub/stacks/<name>/` → `templates/stacks/<name>/` |
| 范围 | `--all` | 所有阶段、所有技术栈；`_shared/` 存在时一并回灌 |
| 目标 | `--to personal` | 个人库，默认 `~/.claude/devflow` |
| 目标 | `--to team` | 团队库，路径由 `hub.yaml` 配置 |
| 目标 | `--to upstream` | 上游插件源码仓库 |
| 修饰 | `--pr` | 团队库或上游库走分支、提交、推送、PR |

`stacks/` 与阶段、共享规则一样可以回灌；技术栈名同样受 `[a-z0-9][a-z0-9_-]*` 约束，`ship` 会把内容写入 `templates/stacks/<name>/`。

### 5.4 哪些内容永远不回灌

| 内容 | 原因 |
| --- | --- |
| `overrides/` | 子项目专属，换项目通常不适用 |
| `hub.yaml` | 项目配置，不同项目路径与命令不同 |
| `project-overview.md` | 派生文档，由各项目重新生成 |
| `ecosystem.yaml` | 项目级工具索引 |
| 账本与本机状态 | 本机或项目状态，不是模板 |

### 5.5 回灌后怎么让其他项目用上

1. 在目标项目的 `hub.yaml` 配置 `templates.order`；
2. 运行 `/devflow:sync`；
3. 运行 `/devflow:doctor` 确认无漂移；
4. 重新生成投影后，新规则才会进入 AI 的读取路径。

回灌只更新库，不会直接修改其他项目的 hub。

## 6. Java / Vue 规范放哪

优先用 `stacks/`：

| 目标 | 放法 |
| --- | --- |
| 同一技术栈的所有子项目、所有阶段 | `.claude/hub/stacks/java-spring/_shared.md` |
| 同一技术栈、只在某些阶段 | `.claude/hub/stacks/<stack>/<stage>.md` |
| 只对某个子项目生效的例外 | `.claude/hub/overrides/<sub>/<stage>.md` |
| 所有阶段都遵守且与语言无关 | `.claude/hub/_shared/` |

配置示例：

```yaml
stack: java-spring
subprojects:
  api:
    path: services/api
    stack: java-spring
  web:
    path: apps/web
    stack: vue3
```

如果栈文件放在 `references/`，在对应栈规范里写清何时读取，例如：

```md
- 修改 Java 代码前，读取 `references/java-style.md`。
```

改完后运行：

```bash
node scripts/devflow-gen.mjs
node scripts/devflow-doctor.mjs
```

栈文件**内容**变化不需要重新生成也能生效，因为投影只记录路径；新增/删除栈文件或修改 `hub.yaml` 的 `stack` 后需要重新生成。

## 7. 常见问题

**hub 创建后是空的吗？**

不是。`init` 会复制六个阶段的完整默认规则，并生成 `hub.yaml` 与项目概览。`_shared/`、`overrides/`、`stacks/` 默认空，按需添加。

**刚安装插件，项目里有什么？**

只有第 1 层。项目里没有 `.claude/hub/`，阶段命令会提示先运行 `/devflow:init`。

**为什么要有第三层，不能直接读 `.claude/hub/`？**

第三层提供技能发现、`_shared/` 内联、资源清单和漂移检测。它也是 Claude Code 加载技能的入口。

**改规则后要做什么？**

改第 2 层，运行 `devflow-gen`，再运行 `devflow-doctor`。不要手改第 3 层。

**为什么 `_shared/` 改了但没生效？**

`_shared/` 在 `devflow-gen` 运行时被内联进项目投影。改完要重新运行 `node scripts/devflow-gen.mjs`（或 `devflow sync`）。

**`overrides/` 为什么没被同步或回灌？**

它是项目专属例外，设计上不进入模板库。

## 8. 当前边界

1. **`stacks/` 是机制，不是规范库**：不内置 Java/Vue 等具体栈正文；内容由个人库、团队库或项目自己维护。
2. **不自动探测技术栈**：`stack` 是项目声明，避免探测结果指向不存在的栈目录。
3. **不做内容级自动合并**：优先级是确定性读取顺序，生成器与 `doctor` 只校验映射是否有效。
4. **不回灌项目配置**：`overrides/`、`hub.yaml`、`project-overview.md`、`ecosystem.yaml` 不同步也不回灌。
