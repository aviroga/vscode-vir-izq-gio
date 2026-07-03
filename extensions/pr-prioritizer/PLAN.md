# Built-in "PR Prioritizer" command for VS Code

## Context

`pr-prioritizer/` (ported from [PR #71](https://github.com/alejandroadorjan/VSCodeORT/pull/71)) is currently a standalone CLI that needs Node, the repo checked out, and a `GITHUB_TOKEN` env var to run. The goal is to let **end users of this VS Code build** generate the same prioritized-PR Markdown report from inside the running app — via the Command Palette — without touching source code or a terminal.

Approach: ship it as a **built-in extension** at `extensions/pr-prioritizer/`, modeled on `extensions/merge-conflict` (build/package conventions) and `extensions/github` (GitHub auth + octokit + git-remote-parsing patterns). The core scoring/report logic (`signals.ts`, `score.ts`, `report.ts`, `types.ts`, `github.ts`) is already pure/offline-capable, so it's reusable almost as-is.

**Decisions already made:**
- Duplicate the core modules into the extension (adapted from ESM to the CJS convention every built-in extension uses) rather than sharing a package across `pr-prioritizer/` and `extensions/`. `pr-prioritizer/` stays untouched as the offline/batch CLI.
- The command auto-detects the target repo from the active workspace's git remote (via the `vscode.git` extension API), falling back to a manual `owner/repo` input box.
- The plan is split into **6 stages**, done **sequentially** (not in parallel) by 3 people, 2 consecutive stages each, in this handoff order: **aviroga → juaniz2001 → Giovanelli18**.

Final layout once all 6 stages land:

```
extensions/pr-prioritizer/
  package.json
  tsconfig.json
  src/
    core/{types,signals,score,report,github}.ts
    auth.ts
    repo.ts
    command.ts
    extension.ts
    test/{score,signals}.test.ts
```

---

## Stage 0 — Publish this plan to the repo
**Owns:** `extensions/pr-prioritizer/PLAN.md` (this file)

- Commit this plan to `feature/pr-prioritizer` and push, so collaborators pulling the branch see it immediately — no need to wait for any code to land first
- Lives next to the code it describes; drop it (or fold the relevant bits into the extension's `README.md`) in the final commit before the PR to `develop`, since it's a working doc, not a shipped artifact

**Verify:** collaborators can `git pull` the branch and read `extensions/pr-prioritizer/PLAN.md`.

---

## Stage 1 — Extension scaffolding & build wiring
**Owns:** `extensions/pr-prioritizer/package.json`, `tsconfig.json`, a minimal `src/extension.ts`, plus the 2 root build files.

- Create `extensions/pr-prioritizer/` with `package.json` (`"main": "./out/extension.js"`, `activationEvents: ["onCommand:prPrioritizer.generateReport"]`, `contributes.commands` entry titled `"PR Prioritizer: Generate Report"`, `dependencies: { "@octokit/rest": ... }` matching the version used in `extensions/github`, `scripts.compile`/`watch` → `gulp compile-extension:pr-prioritizer` / `watch-extension:pr-prioritizer`)
- `tsconfig.json` extending `../tsconfig.base.json`, same shape as `extensions/merge-conflict/tsconfig.json` (CommonJS, `rootDir: src`, `outDir: out`)
- Minimal `src/extension.ts` with `activate()` that registers `prPrioritizer.generateReport` against a placeholder handler (`vscode.window.showInformationMessage('PR Prioritizer: not implemented yet')`), pushed to `context.subscriptions`
- Build wiring: add `'extensions/pr-prioritizer'` to `build/npm/dirs.ts` (alphabetically, next to `merge-conflict`), and `'extensions/pr-prioritizer/tsconfig.json'` to the `compilations` array in `build/gulpfile.extensions.ts`

**Verify:** `gulp compile-extension:pr-prioritizer` succeeds from repo root; launching the Extension Development Host shows the command in the Command Palette and the placeholder message fires.

**Blocks:** everything else — do this first.

---

## Stage 2 — Port the pure core logic
**Owns:** `extensions/pr-prioritizer/src/core/{types,signals,score,report,github}.ts`

- Copy `pr-prioritizer/src/{types,signals,score,report,github}.ts` verbatim into `src/core/`
- Only change: strip the `.js` suffixes off relative imports (e.g. `from './score.js'` → `from './score'`) since built-in extensions compile as CommonJS, not NodeNext ESM
- No VS Code API usage in this stage — these stay pure/testable in isolation, same as the originals

**Verify:** files type-check standalone (`tsc --noEmit` against the extension's `tsconfig.json` once Stage 1 exists); no behavior change vs. the originals in `pr-prioritizer/`.

**Depends on:** Stage 1 (needs the folder + tsconfig to exist). Independent of Stages 3 and 4 — can run in parallel with them.

---

## Stage 3 — GitHub auth integration
**Owns:** `extensions/pr-prioritizer/src/auth.ts`

- `getOctokit()`: `vscode.authentication.getSession('github', ['repo'], { createIfNone: true })` → pass `session.accessToken` into `core/github.ts`'s `createClient(token)`
- Mirror the structure of `extensions/github/src/auth.ts` (including caching the in-flight promise so repeated calls during one report run don't re-prompt)

**Verify:** in the Extension Development Host, a temporary command/log confirms a session is obtained and an authenticated Octokit call (e.g. `client.rest.users.getAuthenticated()`) succeeds.

**Depends on:** Stage 1 (extension shell) and Stage 2 (`core/github.ts`'s `createClient`). Independent of Stage 4.

---

## Stage 4 — Repo auto-detection
**Owns:** `extensions/pr-prioritizer/src/repo.ts`

- `detectRepo()`: `vscode.extensions.getExtension('vscode.git')` → `activate()` → `getAPI(1)` → read `repository.state.remotes`
- Parse `owner/repo` out of the remote URL using the same regex approach as `extensions/github/src/util.ts`'s `getRepositoryFromUrl`
- Fallback: if no git extension, no repo, or no GitHub remote is found, prompt with `vscode.window.showInputBox({ prompt: 'owner/repo' })`

**Verify:** unit-testable regex/parsing logic in isolation; manual smoke test in the Dev Host with a workspace that has a GitHub remote, and one without (confirms the input-box fallback).

**Depends on:** Stage 1 only. Independent of Stages 2 and 3.

---

## Stage 5 — Command orchestration (the actual feature)
**Owns:** `extensions/pr-prioritizer/src/command.ts`, wiring it into `src/extension.ts`

- Replace the Stage 1 placeholder handler with the real flow: `repo.detectRepo()` → `auth.getOctokit()` → `window.withProgress({ location: ProgressLocation.Notification, cancellable: true }, ...)` looping `listOpenPRs` / `getPRDetail` / `getPRReviews` / `getPRFiles` / `normalizePR` from `core/github.ts`, respecting the cancellation token
- Build the `Snapshot` → `core/score.ts`'s `scorePRs()` → `core/report.ts`'s `buildReport()`
- Open the result as an **untitled Markdown document** (`workspace.openTextDocument({ content, language: 'markdown' })` + `showTextDocument`), then `executeCommand('markdown.showPreviewToSide')` for an immediate rendered view — no `fs` writes, works in untrusted/virtual workspaces
- Wrap in try/catch → `window.showErrorMessage` for bad repo format, rate limiting, or auth cancellation
- Read `prPrioritizer.limit` / `prPrioritizer.top` from `contributes.configuration` (defaults 50 / 25) instead of the CLI's flags — add these two keys to `package.json`

**Verify:** end-to-end run in the Dev Host against a real repo with a GitHub-backed remote — command produces a populated, correctly-ranked Markdown report with a side preview.

**Depends on:** Stages 1–4 all complete. This is the integration stage — do it last among the "build" stages.

---

## Stage 6 — Tests + final polish
**Owns:** `extensions/pr-prioritizer/src/test/{score,signals}.test.ts`, end-to-end verification pass

- Port `pr-prioritizer/test/score.test.ts` and `test/signals.test.ts` into `src/test/`, pointed at the Stage 2 `core/` copies (keeps the duplicated logic honest against drift)
- Full verification pass per the checklist below
- Sanity-check the manual-input fallback path (no workspace / no git remote) and the cancellation path (cancel mid-fetch from the progress notification)

**Verify (full checklist):**
1. `cd extensions/pr-prioritizer && npm install`
2. `gulp compile-extension:pr-prioritizer` from repo root
3. `node --test` (or equivalent) on the ported test files
4. Dev Host: run `PR Prioritizer: Generate Report` against a workspace with a GitHub remote, complete the auth prompt, confirm the report + preview
5. Dev Host: same command with no workspace open / no git remote — confirm the manual `owner/repo` input fallback
6. Dev Host: cancel mid-run from the progress notification — confirm it stops cleanly with no error

**Depends on:** Stage 2 (for tests) and Stage 5 (for the full end-to-end checks).

---

## Execution order (sequential handoff, not parallel)

| Order | Owner | Stages | Hands off when... |
| --- | --- | --- | --- |
| 1 | **aviroga** | Stage 0 (this doc) + Stage 1 (scaffolding/build-wiring) + Stage 2 (core port) | `gulp compile-extension:pr-prioritizer` succeeds and `core/` type-checks clean |
| 2 | **juaniz2001** | Stage 3 (GitHub auth) + Stage 4 (repo auto-detection) | both `auth.ts` and `repo.ts` work standalone per their Verify sections |
| 3 | **Giovanelli18** | Stage 5 (command orchestration) + Stage 6 (tests + final e2e verification) | full checklist in Stage 6 passes |

This grouping (1-2 / 3-4 / 5-6) follows the dependency chain exactly, so each person finishes their full tramo and pushes before the next one starts — no one needs to wait mid-stage for someone else's unfinished work.

Each person should push their 2 stages as their own commit(s) on `feature/pr-prioritizer` before notifying the next person to start, to keep the handoff clean and avoid merge conflicts on shared files (`package.json`, `extension.ts`).

## Out of scope for this pass
- Browser/web target
- Persisting the report to a file automatically
- A settings UI beyond the two numeric config keys
- Touching `pr-prioritizer/` (root CLI stays exactly as-is)
