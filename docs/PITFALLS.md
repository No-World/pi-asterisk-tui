# PITFALLS (pi-asterisk-tui)

已知陷阱规则库。改对应区域前先查 Quick Index；无命中再动手。

每条格式：**P\<N\>：标题** + Trap（踩了什么）/ Why（为什么会这样）/ Avoid（怎么避）/ Recovery（已修的话怎么修的，附守护测试或文件）；源自达标事故的条目带 `**Postmortem**:` 链接指向 `docs/postmortems/`（闭环：事故 → postmortem → 规则）。

## 入册门槛（满足其一才入，防规则库稀释）

- 同一个 bug 修了不止一次才修对
- code review 抓到重复出现的错误模式
- P0 级问题（用户主路径不可用 / 数据丢失 / 发布物损坏）

不达标的操作细节不入册。达标事故先按 [docs/postmortems/README.md](./postmortems/README.md) 模板写复盘，再落条目并互链（死链由 `scripts/check-docs.mjs` 兜底）。

## Quick Index

| Area | Key Pitfalls |
|------|--------------|
| （暂无条目——第一条由首个达标事故产生） | — |
