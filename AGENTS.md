# Repository Guidelines

## Project Layout

- `extensions/open-tui/` contains the TypeScript extension source.
- `tests/` contains the `node:test` test files.
- `assets/` contains repository and package images.
- `scripts/` contains repo-level checks (`check-docs.mjs`).
- `docs/` holds decision records, pitfalls, and postmortems; `CONTEXT.md` is the domain glossary.
- `README.md` and `README.zh-CN.md` document user-facing behavior in English and Simplified Chinese.

## Development Commands

```bash
npm install
npm test             # node:test suite + mechanical doc gates
npm run typecheck
npm run check:docs   # doc gates alone (same checks npm test chains in)
pi -e .
```

Use `npm test` for the full test suite (the doc gate runs at the end) and `npm run typecheck` for the strict TypeScript check. Use `pi -e .` to exercise the extension interactively.

## Task Classification

Before any implementation task — a new feature, a non-trivial multi-file change, a settings/config contract change, or anything touching how pi's extension surface is patched — state the classification and surface the design (approach, alternatives, risks) for confirmation first. Producing code or files before that confirmation is the forbidden pattern for implementation-grade tasks.

Exempt (proceed directly): pure Q&A or read-only exploration; docs/typo/comment-only edits; a bug fix with a concrete reproduction and scope from the user; mechanical edits with no design decision; anything the user explicitly says to just do. When ambiguous, default to asking, and state the classification so it can be corrected.

Decisions that survive the discussion become an ADR — see `docs/adrs/README.md` for the format and the entry threshold (hard to reverse / confusing without context / a real trade-off — one of these).

## Documentation Layout

| Document | Answers | Location |
|----------|---------|----------|
| ADR | why a decision was made | `docs/adrs/NNNN-slug.md` (rules: `docs/adrs/README.md`) |
| Glossary | what each domain term means | `CONTEXT.md` (each entry carries an `_Avoid_` anti-synonym) |
| Pitfalls | how to avoid known traps | `docs/PITFALLS.md` |
| Postmortems | incident reviews feeding PITFALLS | `docs/postmortems/` |
| Feature design docs | what to build | `docs/specs/` (create on first use) |

- ADRs use the Nygard format plus a mandatory `Considered Options` section; rejected alternatives get a Rejected ADR too, and superseded ADRs are never deleted — the doc gate enforces all of it.
- Incident loop: qualifying incident → postmortem (`docs/postmortems/README.md` template) → PITFALLS entry (Trap / Why / Avoid / Recovery), cross-linked. The entry threshold in `docs/PITFALLS.md` keeps the rulebook dense.

## Git & PR Discipline

- **Code changes reach `main` through a pull request** — branch `type/scope/short-desc` off `main` (e.g. `feat/footer/token-speed`), push, open the PR. Never merge locally and push `main` directly. Docs-only or typo-level fixes may go direct; when in doubt, open a PR.
- **Conventional Commits**: `type(scope): subject` — types `feat|fix|refactor|perf|chore|docs|style|test`; scopes `tui|footer|hud|editor|telemetry|docs|ops` (or the module actually touched).
- **PR description**: what + why, plus an issue binding — `Closes #N` / `Refs #N` / `No-Issue: <reason>`. CI rejects a PR body containing none of these.
- **Hard gate before merge**: `npm test && npm run typecheck` green. CI runs it on every PR; run it locally too when touching code.
- **Squash-merge**, then delete the branch.
- **Agent vs human**: the agent handles branch/commit/push/open-PR and prepares gate evidence; review and merge are the maintainer's call — the agent never approves or merges its own PR.
- Never stage with a bare `git add -A` / `git add .` — stage explicit paths.

## Quality Gate Placement

New checks pick a host by shape — no scattering (sourced from AgentCloudCity's gate-placement practice):

| Check shape | Host | Precedent |
|-------------|------|-----------|
| Repo-wide, second-scale, zero-dependency | script in `scripts/`, chained into `npm test` | `check-docs.mjs` |
| TypeScript compile level | `npm run typecheck` | `tsc --noEmit` |
| Behavior under a real pi runtime | manual `pi -e .` | — |
| PR-only metadata checks (issue binding) | step in `.github/workflows/pr-checks.yml` | `pr-issue-link` job |
| Staged-file-level checks | git hooks — add only when a real need appears | — |

Consolidate hosts into a scheduler only when: the same check gets duplicated across two hosts, a 3+ step dependency chain appears, or the full local check exceeds a minute.

## Code Conventions

- Keep changes focused and reuse existing modules before adding new abstractions or dependencies.
- Follow the existing TypeScript style: tabs for indentation, double quotes, trailing commas, and explicit `.ts` extensions in relative imports.
- Preserve strict typing. Validate data at external boundaries and keep compatibility workarounds isolated.
- Do not reformat or refactor unrelated code.

## Tests and Documentation

- Add or update focused `node:test` coverage for behavior changes.
- Run the relevant tests and `npm run typecheck` before finishing. For a full check, run `npm test && npm run typecheck`.
- When adding or changing an ADR, keep the `docs/adrs/README.md` index in sync — the doc gate enforces it.
- When settings, configuration, or other user-visible behavior changes, update both README files where applicable, and add or adjust `CONTEXT.md` entries when a concept is introduced or its meaning shifts.
- Do not edit `package-lock.json` unless dependency metadata changes.
