import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DETERMINISTIC_VALIDATOR, SEMANTIC_VALIDATOR, checkClaimAgainstQuote, judgeClaims } from '../src/consistency.js';
import { applyJudgements, type ResearchBrief } from '../src/research.js';
import { IrisVeilError } from '../src/errors.js';
import type { LlmClient } from '../src/llm.js';

describe('checkClaimAgainstQuote', () => {
  const contradicted: Array<[string, string]> = [
    ["We don't serve enterprise teams.", 'Serves enterprise teams.'],
    ['Available in the US only.', 'Available worldwide.'],
    ['Up to 10 integrations.', 'More than 10 integrations.'],
    ['Plans include at least 5 seats.', 'Plans include up to 3 seats.'],
    ['We never store customer data.', 'Stores customer data.'],
  ];
  for (const [quote, claim] of contradicted) {
    it(`contradicts "${claim}" against "${quote}"`, () => {
      assert.equal(checkClaimAgainstQuote(claim, quote).verdict, 'contradicted');
    });
  }

  const unresolved: Array<[string, string]> = [
    ["We don't serve enterprise teams.", 'Does not serve enterprise teams.'],
    ['We serve small businesses.', 'We serve enterprise teams.'],
    ['Up to 10 integrations.', 'Offers up to 10 integrations.'],
    ['No more than 10 seats per plan.', 'Plans cap at 10 seats.'],
    ['Available in the US only.', 'Available in the US.'],
    ['Trusted by Harbor Foods across 37 sites.', 'Harbor Foods is a customer.'],
  ];
  for (const [quote, claim] of unresolved) {
    it(`leaves "${claim}" against "${quote}" to later checks`, () => {
      assert.equal(checkClaimAgainstQuote(claim, quote).verdict, 'unresolved');
    });
  }
});

describe('judgeClaims', () => {
  const items = [
    { id: 's1', claim: 'We serve enterprise teams.', quote: 'We serve small businesses.' },
    { id: 's2', claim: 'Does not serve enterprise teams.', quote: "We don't serve enterprise teams." },
    { id: 's3', claim: 'Ships weekly.', quote: 'We ship every week.' },
  ];
  const fake = (text: string): LlmClient => ({
    provider: 'fake',
    model: 'fake',
    complete: async () => ({ text, usage: { promptTokens: 10, completionTokens: 5 } }),
  });

  it('maps verdicts and fails closed on uncertain or missing ids', async () => {
    const reply = JSON.stringify({
      verdicts: [
        { id: 's1', verdict: 'insufficient_evidence', reason: 'small businesses are not enterprise teams' },
        { id: 's2', verdict: 'supported', reason: 'same meaning' },
        { id: 'zz', verdict: 'supported', reason: 'unknown id' },
      ],
    });
    const { judgements } = await judgeClaims(fake(reply), items);
    assert.equal(judgements.get('s1')!.verdict, 'insufficient_evidence');
    assert.equal(judgements.get('s2')!.verdict, 'supported');
    assert.equal(judgements.get('s3')!.verdict, 'insufficient_evidence', 'missing after repair → not supported');
    assert.equal(judgements.has('zz'), false);
  });

  it('treats uncertain as not supported', async () => {
    const reply = JSON.stringify({ verdicts: items.map(({ id }) => ({ id, verdict: 'uncertain', reason: 'unclear' })) });
    const { judgements } = await judgeClaims(fake(reply), items);
    assert.ok([...judgements.values()].every((j) => j.verdict === 'insufficient_evidence'));
  });

  it('propagates model failures instead of accepting unchecked claims', async () => {
    await assert.rejects(judgeClaims(fake('not json'), items), /could not use/);
  });
});

describe('applyJudgements', () => {
  const brief: ResearchBrief = {
    company: { name: 'A', oneLiner: 'B', offering: '', audience: '' },
    signals: [
      { id: 's1', category: 'customers', claim: 'Serves enterprise.', quote: 'We serve small businesses.', sourceUrl: 'u' },
      { id: 's2', category: 'product', claim: 'Ships weekly.', quote: 'We ship every week.', sourceUrl: 'u' },
    ],
    hypotheses: [
      { statement: 'h1', basedOn: ['s1'], confidence: 'low' },
      { statement: 'h2', basedOn: ['s1', 's2'], confidence: 'low' },
    ],
    dropped: [],
    proposedSignals: 2,
  };

  it('keeps only supported signals and records the rest with their verdict', () => {
    const result = applyJudgements(brief, new Map([
      ['s1', { verdict: 'insufficient_evidence', reason: 'different audience' }],
      ['s2', { verdict: 'supported', reason: 'same' }],
    ]));
    assert.deepEqual(result.signals.map((s) => s.id), ['s2']);
    assert.deepEqual(result.signals[0]!.validatedBy, [DETERMINISTIC_VALIDATOR, SEMANTIC_VALIDATOR]);
    assert.deepEqual(result.dropped[0], { claim: 'Serves enterprise.', quote: 'We serve small businesses.', sourceUrl: 'u', verdict: 'insufficient_evidence', validator: SEMANTIC_VALIDATOR, reason: 'different audience' });
    assert.deepEqual(result.hypotheses, [{ statement: 'h2', basedOn: ['s2'], confidence: 'low' }]);
  });

  it('refuses to continue when no claim is supported', () => {
    assert.throws(() => applyJudgements(brief, new Map()), (e: unknown) => e instanceof IrisVeilError && e.code === 'INSUFFICIENT_EVIDENCE');
  });
});
