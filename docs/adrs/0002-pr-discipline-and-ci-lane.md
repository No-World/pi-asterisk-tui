# 2. PR 纪律与 CI 门禁 lane

Date: 2026-09-04

## Status

Accepted

## Context

仓库是单维护者的公开 GitHub 项目，此前改动直接提交 `main`：验证只剩「本地跑过即算过」，改动动机无处留痕（issue 与 commit 断联），历史里混着大颗粒提交。AgentCloudCity 的实践（PR 驱动合入 + hard gate 实跑 + PR↔issue 绑定声明 + agent 不自批不自合）验证了：即使单人 + agent 协作，PR 也是一个便宜的审查面与留痕面。ADR-0001 已把文档门禁并入 `npm test`，但尚无强制执行点。

## Decision

1. **代码变更一律走 PR 进 `main`**：分支 `type/scope/short-desc`，squash 合并后删分支；纯文档/typo 可直推，拿不准就开 PR。
2. **CI lane**（`.github/workflows/pr-checks.yml`）：`pull_request`（含 `edited`，覆盖 PR 描述修改）与 `push: main` 上跑 `npm ci` → `npm test`（内含文档门禁）→ `npm run typecheck`；同 PR 新推送取消旧 run。
3. **PR↔issue 绑定声明**：PR 描述须含 `Closes #N` / `Fixes #N` / `Resolves #N` / `Refs #N` 之一，或显式 `No-Issue: <原因>` 豁免；CI 机械校验，缺失即红。
4. **agent 与人的分工**：agent 负责分支/提交/推送/开 PR/备齐门禁证据；review 与合并是维护者的决定，agent 不自批不自合。
5. 提交信息走 Conventional Commits（8 type + 模块 scope）；禁裸 `git add -A`，一律显式路径 staging。

## Considered Options

- **维持单人直推 main** — 否：验证只剩自觉（agent 会话里尤其容易漏跑），改动动机无处留痕；PR 的边际成本只有一次点击，换来强制验证面与留痕面。
- **全套 AgentCloudCity 三层 GitFlow（main/dev/feature）** — 否：单人仓没有集成分支的并行压力，多一层常驻分支纯付税。
- **绑定校验只写进 PR 模板、不进 CI** — 否：模板是提醒不是门禁；AgentCloudCity ADR-0034 的教训是声明式约束要机械校验才算数。

## Consequences

- 正面：每个进 main 的提交都过了同一组门禁且有 PR 留痕；issue（或 No-Issue 原因）与改动一一对应；agent 无法绕过人合入代码。
- 成本：每次改动多一次开 PR/合 PR 的操作；CI 首跑可能暴露 `npm ci` 在 CI 环境的安装差异（peer 包的原生 postinstall 等），需要时再调。
- 后续：PR 模板已同步补绑定声明位；若将来出现多贡献者，再考虑分支保护规则。
