# Working in this repo

Notes for people and coding agents. See `README.md` for usage and `docs/architecture.md` for how the editor works.

## Commands

```sh
npm install
npm run dev        # playground: note composer at /, React at /react.html
npm test           # unit, spec and round-trip tests (vitest)
npm run test:e2e   # browser tests (Playwright, Chromium)
npx playwright test --project=firefox --project=webkit  # the browser tests in Firefox and WebKit (needs those browsers)
npm run test:perf  # timing gates, run alone
npm run typecheck
npm run build      # the published files, in packages/editor/dist
npm run size       # what each published entry adds to an app, minified and gzipped
```

## Releasing

Versions follow the same CalVer as memos ([discussion](https://github.com/orgs/usememos/discussions/6351)): `year.month.n`, where `n` counts the releases that month from 0. The release workflow picks the version from today's date (UTC) and the versions already on npm. The first release in October 2026 is `26.10.0`, the second `26.10.1`, and the first in April 2027 is `27.4.0`. `version` in `packages/editor/package.json` stays `0.0.0` in the repo.

To release, open Actions, pick "Release" and choose "Run workflow" on main. The workflow (`.github/workflows/release.yml`) works out the version, runs the typecheck and tests, and publishes to npm under the `latest` tag. There are no release candidates, git tags, GitHub releases or release notes. The version does not signal breaking changes, so apps should pin an exact version, and commits marked with `!` show what breaks.

Publishing uses npm trusted publishing, as `usememos/mui` does, so there is no npm token. On npmjs.com, the `@usememos/editor` package settings list `usememos/editor` and `release.yml` under "Trusted Publisher".

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

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
