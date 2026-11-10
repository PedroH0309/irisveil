# Session handoff

Read this first in every new session; rewrite it when asked for a handoff.

Last updated: 2026-11-11

## Goal right now

Complete [issue #9](https://github.com/YourAKShaw/irisveil/issues/9): prevent unsupported or contradictory claims from reaching verified research and outreach. The user asked for the first of two issues to be fixed end to end and linked in a PR; issue #10 is not yet in scope.

Use atomic Conventional Commits with the existing trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Use branches named `YourAKShaw/<type>/<brief-description>`. Push only when the user authorizes it; the request to create the issue PR authorized pushing its branch. Edit the user's `.env` only on request. Do not mention the reserved domain in project content. Licensing is AGPL-3.0-only plus [CLA](CLA.md).

## Where things stand

- Branch: `YourAKShaw/fix/9-claim-evidence-consistency`, tracking the matching origin branch. [Draft PR #11](https://github.com/YourAKShaw/irisveil/pull/11) links #9 and is **not ready to merge**.
- Commit `0b7f812` adds a characterization in [test/research.test.ts](test/research.test.ts): a genuine quote denying enterprise service is accepted with the opposite claim. The test records the bug and must be inverted when fixed. No production fix exists yet.
- `npm run check` passed (153 tests); `npm run build` passed. No live provider or website evaluation was run. This handoff commit has not been pushed.
- `main` matched `origin/main` after fetching this session. The earlier handoff's four unpushed main commits are no longer outstanding.

## Next steps

1. Read issue #9 and its implementation-direction comment, then implement and evaluate fail-closed claim–evidence validation in [src/research.ts](src/research.ts), including source URL, quote, verdict, validator path and rejection reason in the audit trail. Cover company and imported profile facts and the issue's adversarial fixtures; assess false acceptance and false rejection rather than relying on negation matching alone.
2. Inspect [src/outreach.ts](src/outreach.ts): the drafting prompt also receives independently generated company summary fields. Ensure unsupported claims cannot reach drafts through that path. Test the entire pipeline and error/uncertainty handling, then update documentation and PR #11 with observed results and limitations.
3. Check the sender fields in the web form after restarting `irisveil serve` and hard-reloading. If deploying on Render, check the renamed service in [render.yaml](render.yaml).
4. Separately, improve profile extraction reliability in `researchCompany` and quote matching for Markdown emphasis and PDF line-break hyphens; test with the user's local profile fixtures when appropriate. This was an earlier outstanding task, not necessarily part of #9.

## Open questions

- A lawyer should review [CLA.md](CLA.md) before commercial launch.
- Optional Gemini CLI support remains unrequested; that account previously needed `GOOGLE_CLOUD_PROJECT`.

## Gotchas

- Groq's free tier can hit its token limit with both profile files; local `--claude` previously worked reliably. An additional semantic model call has latency and cost implications.
- `irisveil serve` caches static assets at startup. LinkedIn and X block anonymous fetches; profiles are supplied as files.
- The sandbox failed to initialize its network namespace in this session; commands worked with escalation. Do not expose local secrets in logs or PRs.
