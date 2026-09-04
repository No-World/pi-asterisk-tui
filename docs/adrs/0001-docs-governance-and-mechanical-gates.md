# 1. 文档治理与机械门禁先行（ADR / PITFALLS / 术语表 / check-docs）

Date: 2026-09-04

## Status

Accepted

## Context

仓库此前只有 README（用户视角）与 AGENTS.md（贡献规范）：设计取舍留在会话里随上下文流失，踩过的坑没有载体，术语（✻ 行 / 单轮遥测 / HUD 底栏…）靠 README 叙事隐式定义。借鉴 AgentCloudCity 的治理实践（ADR 体系 + PITFALLS 事故闭环 + 文档机械门禁 + 门禁放置表），以接近零的内容投入补齐这层。

## Decision

落地治理骨架，但**不**引入全套 SDD 四阶段流程：

1. `docs/adrs/` — Nygard 四段式 + 强制 `Considered Options` 段；Rejected 也立 ADR；被推翻改 Status 不删文件（规则见 `docs/adrs/README.md`）。
2. `docs/PITFALLS.md` — Trap/Why/Avoid/Recovery 规则库，带入册门槛（满足其一：bug 修了不止一次才对 / review 抓到重复模式 / P0）。
3. `docs/postmortems/` — 达标事故先按模板复盘，再落 PITFALLS 条目并互链（事故 → postmortem → 规则闭环）。
4. `CONTEXT.md` — 领域术语表，每词条带 `_Avoid_` 反义澄清。
5. `scripts/check-docs.mjs` — 机械门禁：markdown 死链、ADR 编号唯一 + 索引一致 + Status 合法 + Considered Options 存在、postmortem 四要素形状；并入 `npm test`，自带 `--selftest` 验证门禁自身。
6. AGENTS.md 增任务分类规则（实现类任务先摆方案再动手）与质量门禁放置表。

## Considered Options

- **不引入，出事故再补** — 否：这层骨架的内容投入几乎为零，而第一手事故语境最难事后复原，等价于主动放弃可复盘性。
- **全套 AgentCloudCity SDD（四阶段 + vendored skills + 分模块 ADR 目录）** — 否：单模块 TS 扩展仓，流程税远大于收益；分目录独立编号也不需要。
- **只加 ADR，不加机械门禁** — 否：文档规则不靠测试/CI 守就会漂移（索引漏更、死链累积）；门禁脚本是本方案唯一要维护的代码，换文档一致性值得。

## Consequences

- 正面：决策、事故、术语各有唯一归宿；`npm test` 顺带守住文档一致性；后来者（含 agent）不必重吵已有结论的问题。
- 成本：新增/改动 ADR 须同步 README 索引（门禁兜底）；ADR 有固定格式成本——以入册门槛克制使用。
- 后续：将来建 CI 时 lane 原样跑 `npm test && npm run typecheck` 即继承全部门禁；首个跨功能设计文档出现时创建 `docs/specs/`。
