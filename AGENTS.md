# Working in this repo

Notes for people and coding agents. See `README.md` for usage and `docs/architecture.md` for how the editor works.

## Commands

```sh
npm install
npm run dev        # playground: core at /, React at /react.html, memos setup at /memos.html
npm test           # unit, spec and round-trip tests (vitest)
npm run test:e2e   # browser tests (Playwright, Chromium)
npm run test:perf  # timing gates, run alone
npm run typecheck
```

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/), the same style as `usememos/memos`:

```
<type>(<scope>): <summary>
```

- **type**: `feat`, `fix`, `refactor`, `perf`, `test`, `docs` or `chore`. Add `!` after the type or scope for a breaking change, e.g. `refactor(core)!: rename getDoc to getDocument`.
- **scope** (optional): the area changed, e.g. `core`, `react`, `markdown`, `clipboard`, `ui`, `playground`, `e2e`. Leave it out when a change spans several areas.
- **summary**: lowercase, imperative ("add", not "added"), no period at the end, under about 72 characters.
- **body** (optional, after a blank line): why the change was made, in plain sentences or `-` bullets. Wrap at 72 characters.

Examples:

```
feat(ui): add a formatting toolbar for selected text
fix(core): keep the caret in place after Enter and an arrow key
perf(core): skip layout for off-screen blocks on load
docs: describe the v0 architecture
```
