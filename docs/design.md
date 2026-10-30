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
| 命令归属 | 插件统一提供 `/devflow:*` |
| 初始化 | 内置模板 + 自动探测 |

## 分层

```
插件（出厂默认）
  commands/ + skills/ + agents/ + hooks/ + templates/
        │ init 时复制模板
        ▼
项目 .claude/hub/（项目真源）
  hub.yaml + stages/<stage>/{SKILL.md, references/, templates/} + _shared/
        │ 生成器投影
        ▼
项目 .claude/skills/devflow-*（薄壳）
```

## 职责边界

- 插件级 `skills/`（工程流程、TDD、评审、排障、hub 管理）是**跨项目通用能力**，描述“怎么做”。
- `templates/stages/` 是**项目级阶段规则**，init 复制为 `.claude/hub/`，描述“本项目每个阶段的具体规范”。
- 两者主题相近但用途不同，不互相替代：修改阶段规范只动项目 hub，修改通用方法论才动插件 skills。

## 六阶段与门禁

| 阶段 | 产出 | 硬门禁 |
| --- | --- | --- |
| req | req.md | 验收标准非空，未知项列明 |
| plan | plan.md | 每个改动点有验证方式 |
| implement | 代码 | 小步，可编译，优先 TDD |
| test | 测试证据 | 通过要有命令与输出 |
| review | 评审结论 | 高危未修不得通过 |
| debug | 根因与回归 | 无复现不下结论 |

## hooks

`guard-dangerous` 对所有项目生效；状态记录、结束提醒与会话注入只对含 `.claude/hub/hub.yaml` 的项目生效。

| 事件 | 行为 |
| --- | --- |
| PreToolUse(Bash) | 危险命令阻止 |
| PostToolUse(Edit/Write) | 记录改动文件 |
| Stop | 有改动但未测试则提醒 |
| SessionStart | 注入当前子项目和测试命令 |

## 回灌与升级

`hub-upstream` 递归对比项目 stage 目录与插件模板，分类为 project-local / reusable；只把 reusable 写入插件模板，手动确认后 bump 版本。回灌目标由显式 `--plugin-root` > `.devflow.json` 的 `pluginSourceRoot` > 运行时插件根依次决定，落在安装缓存的写入会被拒绝。

插件升级后，`hub-sync` 依据 `.claude/.hub-sources.json` 的源文件哈希，区分“未改可更新”与“手改需保留”：未改文件跟随新模板，手改文件默认跳过，`--force` 覆盖前生成 `.bak` 备份。同步只动 `stages/`，不碰 `hub.yaml` 与 `overrides/`。

版本号有 `.claude-plugin/plugin.json`、`package.json`、`.claude-plugin/marketplace.json`（`metadata.version`）三处，必须一致；回灌/`ship` 的 `--apply --bump <patch|minor|major>` 会同时更新，清单测试负责校验漂移。

## 安全边界

`guard-dangerous` 是基于正则的尽力拦截，不是沙箱；四个钩子一律 fail-open。安全模型、凭据处理与加固建议见 `SECURITY.md`。这个取舍保证正常的开发操作不会因钩子本身出错而被卡死。

## 里程碑

- [x] 插件骨架、命令、技能、agent
- [x] hub 脚本：init / gen / doctor / upstream / ship / sync / mark-test
- [x] hooks 脚本
- [x] 测试与示例工作区验证（`node --test` 全绿，覆盖脚本、hooks、清单一致性与端到端链路）
- [x] 文档与版本 1.2.0
