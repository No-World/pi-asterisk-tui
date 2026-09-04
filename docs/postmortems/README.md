# Postmortems

达标事故（门槛见 [../PITFALLS.md](../PITFALLS.md)）的复盘记录。闭环：**事故 → postmortem → PITFALLS 规则**，双向互链。

## 模板（复制为 `YYYY-MM-DD-slug.md`）

```markdown
# <现象一句话>

Date: YYYY-MM-DD
Rule: docs/PITFALLS.md 的 P<N>（本 postmortem 催生/对应的规则；已有则引用，没有则先落规则）

## Timeline
（时间顺序的事实：发现 → 误判 → 定位 → 修复。只写可考证的，不补写印象。）

## Root cause
（技术根因 + 为什么防线没拦住：哪一层本该拦而没拦。）

## Guardrails
（落地了什么防线：测试 / 门禁 / 规则条目，附文件路径与引用。）
```

写完回 [../PITFALLS.md](../PITFALLS.md) 对应条目补 `**Postmortem**:` 链接。

文件名日期前缀、`Rule:` 行与 `## Timeline` / `## Root cause` / `## Guardrails` 三段由 `scripts/check-docs.mjs` 机械校验；互链死链同由该门禁兜住。
