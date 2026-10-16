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

Versions follow the same CalVer as memos ([discussion](https://github.com/orgs/usememos/discussions/6351)): a release is named after the year and month it ships. The release workflow picks the version from today's date (UTC) and the versions already on npm:

| Release | Version | npm version | npm tag |
| --- | --- | --- | --- |
| First in October 2026 | `26.10` | `26.10.0` | `latest` |
| Second in October 2026 | `26.10.1` | `26.10.1` | `latest` |
| Release candidate before 26.10 | `26.10-rc.1` | `26.10.0-rc.1` | `next` |
| First in April 2027 | `27.04` | `27.4.0` | `latest` |

npm needs three numbers without leading zeros, so the workflow converts the version for npm. `version` in `packages/editor/package.json` stays `0.0.0` in the repo.

To release, open Actions, pick "Release" and choose "Run workflow" on main. Tick "Release candidate" for an `-rc` version. The workflow (`.github/workflows/release.yml`) works out the version, runs the tests and publishes to npm. Releases are not tagged in git, and there is no GitHub release or release notes. The version does not signal breaking changes, so apps should pin an exact version, and commits marked with `!` show what breaks.

Publishing uses npm trusted publishing, as `usememos/mui` does, so there is no npm token. On npmjs.com, the `@usememos/editor` package settings list `usememos/editor` and `release.yml` under "Trusted Publisher".

## Pushing and CI

The repo is private, so every CI minute is billed. Each push to main runs the checks and the Chromium browser tests (about 7 minutes); Firefox and WebKit run each night when main changed (see `docs/architecture.md`). So:

- Push once per finished change, not once per commit: commit as you go, run `npm test` and the affected browser tests locally, then push the commits together.
- Changes to `docs/`, `*.md` at the top level and `packages/*/*.md` run no CI.
- To try a fix in Firefox or WebKit before pushing to main, push a branch and run the CI workflow on it by hand ("Run workflow" in Actions), or run `npx playwright test --project=webkit` locally.

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
