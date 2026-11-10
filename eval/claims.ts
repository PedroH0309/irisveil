/**
 * Claim–evidence evaluation: compares deterministic-only, judge-only and layered validation
 * on the labeled fixtures, reporting false acceptance and false rejection separately.
 *
 *   npx tsx eval/claims.ts            # deterministic only (no model calls)
 *   npx tsx eval/claims.ts --claude   # also runs the judge through the signed-in Claude Code CLI
 *   npx tsx eval/claims.ts --api      # also runs the judge through the configured API provider
 */
import { readFileSync } from 'node:fs';
import { checkClaimAgainstQuote, judgeClaims, type ClaimVerdict } from '../src/consistency.js';
import { createAgentClient } from '../src/local-agent.js';
import { createLlmClient } from '../src/llm.js';
import { loadConfig } from '../src/config.js';

const log = (line: string) => process.stdout.write(`${line}\n`);

interface Case { quote: string; claim: string; label: ClaimVerdict; kind: string }

const cases = JSON.parse(readFileSync(new URL('../test/fixtures/claim-evidence.json', import.meta.url), 'utf8')) as Case[];

function score(name: string, accepted: boolean[], extra = '', reasons: string[] = []) {
  const bad = cases.map((c, i) => ({ c, ok: accepted[i]!, why: reasons[i] })).filter(({ c, ok }) => (c.label === 'supported') !== ok);
  const unsupported = cases.filter((c) => c.label !== 'supported').length;
  const supported = cases.length - unsupported;
  const falseAccept = bad.filter(({ c }) => c.label !== 'supported');
  const falseReject = bad.filter(({ c }) => c.label === 'supported');
  log(`\n${name}${extra}`);
  log(`  false acceptance: ${falseAccept.length}/${unsupported}   false rejection: ${falseReject.length}/${supported}`);
  for (const { c, why } of bad) log(`  ✗ [${c.label}/${c.kind}] "${c.claim}" ← "${c.quote}"${why ? ` (${why})` : ''}`);
}

const guard = cases.map((c) => checkClaimAgainstQuote(c.claim, c.quote).verdict);
// Deterministic-only cannot establish support, so "accept when not contradicted" is its best case.
score('deterministic only (accept unless contradicted)', guard.map((v) => v !== 'contradicted'));
log(`  contradictions caught by rules: ${guard.filter((v) => v === 'contradicted').length}/${cases.filter((c) => c.label === 'contradicted').length}`);

const mode = process.argv[2];
if (mode === '--claude' || mode === '--api') {
  const llm = mode === '--claude' ? createAgentClient('claude', { timeoutMs: 180_000 }) : createLlmClient(loadConfig().llm);
  const started = Date.now();
  const items = cases.map((c, i) => ({ id: `c${i}`, claim: c.claim, quote: c.quote }));
  const { judgements, usage } = await judgeClaims(llm, items);
  const judge = items.map((item) => judgements.get(item.id)!.verdict === 'supported');
  const cost = ` — ${llm.model}, ${((Date.now() - started) / 1000).toFixed(1)}s, ${usage.promptTokens}+${usage.completionTokens} tokens`;
  const reasons = items.map((item) => judgements.get(item.id)!.reason);
  score('judge only', judge, cost, reasons);
  score('layered (rules, then judge)', judge.map((ok, i) => ok && guard[i] !== 'contradicted'));
}
