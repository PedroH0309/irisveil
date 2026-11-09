# Session handoff

Read this first in every new session; rewrite it at the end of a session when asked for a handoff.

Last updated: 2026-11-10

## Goal right now

Polish IrisVeil (formerly Iris), a CLI and web app that drafts cold emails from verified website facts, as an open-source project the owner will later also sell as a hosted service.
Constraints: one atomic Conventional Commit per change, trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>` (checked in CI by `.github/scripts/lint-commit.py`); push only when the user says so; the local `.env` is the user's, so don't edit it.
Licensing: AGPL-3.0-only plus a CLA ([CLA.md](CLA.md)). The domain irisveil.ai must not be mentioned anywhere yet.

## Where things stand

- Branch: `main`, remote `origin` = `git@github.com:YourAKShaw/irisveil.git` (repo renamed from `iris`; the local folder is still `iris`).
- Done this session: README and SECURITY moved to the root; CI pins actions and checks commits; AGPL relicense; CLA Assistant Lite (`.github/workflows/cla.yml`, signatures branch `cla-signatures` already on GitHub); AGPL source link in the web footer (`IRISVEIL_SOURCE_URL`); full Iris → IrisVeil rebrand; new screenshot; `--claude/--codex/--antigravity/--grok` local-CLI flags ([src/local-agent.ts](src/local-agent.ts)); LinkedIn PDF and X Markdown profile files ([src/profiles.ts](src/profiles.ts)).
- Wiki is live at github.com/YourAKShaw/irisveil/wiki (separate repo `irisveil.wiki.git`, already pushed).
- Unpushed: 10 commits (`git log origin/main..HEAD`), including breaking changes (command `irisveil`, `IRISVEIL_*` env vars, AGPL).
- Checks: `npm run check` → 151 pass, lint clean; `npm run build` OK.

## Next steps

1. Ask the user to push `main`, then confirm CI (`ci.yml` and the commit-lint job) passes on GitHub. The wiki's screenshot updates automatically after the push.
2. If the user deploys on Render: the Blueprint service name changed to `irisveil` ([render.yaml](render.yaml)); check the existing service still builds.
3. Make profile research reliable on API providers: give each profile its own small extraction call instead of sharing the company research prompt ([src/research.ts](src/research.ts) `researchCompany`). Also make quote matching tolerate Markdown `**` and PDF line-break hyphens (`normalizeForMatch`). Test with the user's files in `~/Downloads/iris-test/`. It already works well with `--claude`.
4. Later, on request: a private repo for the paid hosted version (accounts, payment gateway). The open repo stays self-hostable.

## Open questions

- A lawyer should review [CLA.md](CLA.md) (it's an adapted draft) before commercial launch.
- Optional `--gemini` flag: the Gemini CLI fails on this account until `GOOGLE_CLOUD_PROJECT` is set. Not requested.

## Gotchas

- Groq's free tier is 8K tokens/min; a run with both profile files can hit it. `gemini-3.8-flash` hung on the user's key. `--claude` is the reliable path.
- `irisveil serve` caches static assets at startup: restart the server after editing `public/`, and hard-reload the browser.
- `pkill -f`/`pgrep -f` patterns can match your own shell's command line and kill it; kill by PID instead.
- LinkedIn and X block anonymous fetches (sign-in redirect loops); that's why profiles are files. Don't try to scrape them.
- The `gh` CLI has no wiki commands: clone `git@github.com:YourAKShaw/irisveil.wiki.git`, edit, commit, push. Quote Mermaid labels or GitHub won't render them.
- The user's `.env` still sets the sender company to NayaManas; it shows up in live drafts.
