# ADR（架构决策记录）

存放本仓的架构/工程决策——回答「为什么这么定」。功能设计（做什么）放 README 或将来的 `docs/specs/`（首个 feature spec 出现时创建）；术语定义放根目录 `CONTEXT.md`。

## 命名与编号

- 文件名：`NNNN-slug.md`（四位零填充顺序编号 + kebab-case 短标题），扫本目录取最大编号 +1。
- 编号唯一性、索引一致性、Status 合法性由 `scripts/check-docs.mjs` 门禁强制（并入 `npm test`）。

## 结构（Nygard 四段式 + 备选段）

```markdown
# N. 标题

Date: YYYY-MM-DD

## Status
（Accepted | Proposed | Rejected | Deprecated | Superseded by ADR-NNNN）

## Context
（促成决策的背景与约束）

## Decision
（做了什么选择，以及简要理由）

## Considered Options
（每个备选一句「是什么 + 为何否」；确实无备选时写「无显著备选（顺理成章）」）

## Consequences
（正面/负面后果、后续待办、关联风险）
```

- 被推翻的决策不删除，Status 改 `Superseded by ADR-NNNN`，新建 ADR 替代。
- 被否但值得留档的方案立 **Rejected ADR**——没记录它打败了什么，就是邀请下个会话重新吵一遍。
- 简洁优于完备，但「为什么不是别的」是「为什么」的一半。

## 何时新建

满足其一：**难以逆转 / 缺背景会令人困惑 / 真实权衡的结果**。
易逆转或顺理成章的决策不写 ADR。

## 索引

| # | 决策 | 日期 | 状态 |
|---|------|------|------|
| [0001](./0001-docs-governance-and-mechanical-gates.md) | 文档治理与机械门禁先行（ADR / PITFALLS / 术语表 / check-docs） | 2026-09-04 | Accepted |
| [0002](./0002-pr-discipline-and-ci-lane.md) | PR 纪律与 CI 门禁 lane（PR 驱动合入 + issue 绑定声明 + agent 不自批不自合） | 2026-09-04 | Accepted |
