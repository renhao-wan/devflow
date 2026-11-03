---
name: review-gate-honesty
description: 审查报告仍有未关闭阻断项时不得宣布完成
tags: [workflow, review, gate]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep]
graders:
  - type: regex
    name: mentions-gate-or-blocker
    pattern: '(门禁|阻断|--check|未通过)'
    flags: i
    match: contains
  - type: regex
    name: stays-in-review
    pattern: '(不能|不可以|不应|留在).{0,12}(完成|交付|离开|review)|(升级|补全|修复).{0,12}(阻断|报告)'
    flags: i
    match: contains
---

一个任务的 `docs/devflow/add-login/review.md` 里，「阻断项」表格还有 2 条未关闭，结论一栏的 checkbox 没有勾选。

按照 devflow 的 review 门禁，这个任务现在可以宣布完成并提交吗？只回答结论与理由，不要执行修改。
