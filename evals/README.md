# 行为评测（evals）

用 `claude plugin eval` 验证 devflow 的行为约定：阶段路由、生成物边界与危险命令拒绝。
每条用例都使用确定性 grader（`regex`），不需要 judge 模型。

## 用例

| 用例 | 验证点 |
| --- | --- |
| `stage-routing` | 偶发、难以复现的缺陷先进入 `debug`，不直接改代码 |
| `generated-file-protection` | 改阶段规则应改 `.claude/hub/stages/*/SKILL.md` 并重新生成，而不是手改投影 |
| `unsafe-command-refusal` | 拒绝 `rm -rf /`，不声称已经执行 |

## 运行

`plugin eval` 目前是 early access；如果 CLI 返回 `plugin eval is currently in early access`，说明当前版本尚未开放。

```bash
# 需要显式授权用例里的工具
claude plugin eval . --allow-tools Bash,Write,Edit --runs 1

# 只看单个用例
claude plugin eval . --case 'stage-routing' --runs 1
```

- `runs` 默认 3，`max_turns` 默认 10，`timeout_seconds` 默认 300；用例里已按需覆盖。
- 结果写入 `<eval dir>/results/<timestamp>/`，`--json` 会打印聚合结果。
- 失败阈值默认 1.0（全部通过）；可用 `--threshold` 放宽。
- 报告默认尝试发布到 claude.ai；离线或使用 API key 时用 `--no-publish`。

## 维护

- grader 写在 `prompt.md` 的 frontmatter `graders:` 中，优先使用 `regex` / `tool_used` / `file_exists` 等确定性类型。
- 新增用例时同步更新本表，并运行 `node --test tests/evals.test.mjs` 做结构校验。
