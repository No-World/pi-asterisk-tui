# Repository Guidelines

## Project Layout

- `extensions/open-tui/` contains the TypeScript extension source.
- `tests/` contains the `node:test` test files.
- `assets/` contains repository and package images.
- `README.md` and `README.zh-CN.md` document user-facing behavior in English and Simplified Chinese.

## Development Commands

```bash
npm install
npm test
npm run typecheck
pi -e .
```

Use `npm test` for the full test suite and `npm run typecheck` for the strict TypeScript check. Use `pi -e .` to exercise the extension interactively.

## Code Conventions

- Keep changes focused and reuse existing modules before adding new abstractions or dependencies.
- Follow the existing TypeScript style: tabs for indentation, double quotes, trailing commas, and explicit `.ts` extensions in relative imports.
- Preserve strict typing. Validate data at external boundaries and keep compatibility workarounds isolated.
- Do not reformat or refactor unrelated code.

## Tests and Documentation

- Add or update focused `node:test` coverage for behavior changes.
- Run the relevant tests and `npm run typecheck` before finishing. For a full check, run `npm test && npm run typecheck`.
- When settings, configuration, or other user-visible behavior changes, update both README files where applicable.
- Do not edit `package-lock.json` unless dependency metadata changes.
