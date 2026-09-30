# 7. 发布闸门前移：GitHub Release 发布触发 npm publish

Date: 2026-09-30

## Status

Accepted

## Context

原机制为 tag 推送直接触发 npm publish（OIDC trusted publishing，不可逆），GitHub Release 是事后手动补的装饰步骤。v0.8.0 发布时暴露了两个真实事故样本：

- **v0.7.1**：npm 已发布，GitHub Release 完全漏建——changelog 无处安放
- **v0.8.0**：tag 推送 21 秒后包即上线，而 release notes 当时还不存在——用户从 npm 装到 0.8.0 时没有任何发布说明

失败模式的本质：忘建 release 的后果落在"发一个无 notes 的包"上，而 npm 版本号不可逆。正确的失败方向应该是"没发"而不是"发了个没说明的"。

## Decision

发布闸门前移，npm publish 的触发器从 tag 推送改为 **GitHub Release 的 published 事件**，tag 推送只负责创建待办物：

1. `release-draft.yml`（新增）：`v*` tag 推送 → 自动创建 **draft release**，预填 GitHub 自动生成的 PR 清单——推 tag 后立即可见待办，不会再漏
2. `npm-publish.yml`（触发器改造，**文件名不可动**——npmjs 的 trusted-publisher 配置钉死 workflow 文件名，改名 OIDC 直接失效）：`on: release: published` → checkout `${{ github.event.release.tag_name }}` → 一致性门禁（`package.json` 版本 ≠ tag 即 fail fast）→ 原有 test+typecheck 门禁 → publish

流程：**合 version PR → 推 tag（草稿自动出现）→ 补 highlights → 点 publish → npm 上线**。release notes 从"事后补"变成"发布闸门"。

非 `v*` tag 的 release 由 job 级前缀守卫跳过；prerelease 的 `--tag next` 分流暂不做（无此场景，TODO）。

## Considered Options

- **维持 tag 直发**：零改动，但失败方向错误（无 notes 的包照发），两次事故已经证明——否。
- **纯 release 触发、无自动草稿**：少一个 workflow，但推 tag 后无可见待办物，"忘建 release"从漏 notes 变成漏发版，靠人脑记忆兜底——否，草稿自动化正是防漏的关键。

## Consequences

- 正面：notes 先于包存在；推 tag 后草稿即待办；一致性门禁拦住"tag 指错版本"类事故。
- 负面：发版多一次人工点击（publish release）；删 release 重建时 npm 对已占版本 403（npm 语义，不管）。
- 关联：v0.7.1 漏档与 v0.8.0 无 notes 发布（本 ADR 的 Context 来源）；npmjs trusted-publisher 配置约束（workflow 文件名）。
