import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEmail, mentionsFactIds, parseRecipient, stripFactIds, wordCount } from '../src/outreach.js';

const ids = new Set(['s1', 's2']);
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const email = (overrides: Partial<{ angle: string; subject: string; body: string; basedOn: string[] }> = {}) => ({
  angle: 'Angle',
  subject: 'A specific subject line',
  body: words(80),
  basedOn: ['s1'],
  ...overrides,
});

describe('checkEmail', () => {
  it('accepts a grounded, well-formed draft', () => {
    assert.deepEqual(checkEmail(email(), ids, 0), []);
  });

  it('rejects links, including bare domains with paths', () => {
    for (const body of [`${words(60)} https://evil.example`, `${words(60)} www.evil.example`, `${words(60)} evil.com/claim`]) {
      assert.match(checkEmail(email({ body }), ids, 0).join(' '), /links or URLs/);
    }
  });

  it('allows a plain company domain without a path', () => {
    assert.deepEqual(checkEmail(email({ body: `${words(60)} at acme.com today` }), ids, 0), []);
  });

  it('rejects placeholders', () => {
    assert.match(checkEmail(email({ body: `Hi [First Name], ${words(60)}` }), ids, 0).join(' '), /placeholders/);
    assert.match(checkEmail(email({ body: `Hi {{name}}, ${words(60)}` }), ids, 0).join(' '), /placeholders/);
  });

  it('enforces length limits', () => {
    assert.match(checkEmail(email({ body: words(20) }), ids, 0).join(' '), /40–170 words/);
    assert.match(checkEmail(email({ body: words(400) }), ids, 0).join(' '), /40–170 words/);
    assert.match(checkEmail(email({ subject: 'x'.repeat(120) }), ids, 0).join(' '), /subject/);
  });

  it('requires at least one verified fact', () => {
    assert.match(checkEmail(email({ basedOn: [] }), ids, 0).join(' '), /basedOn/);
    assert.match(checkEmail(email({ basedOn: ['s9'] }), ids, 0).join(' '), /basedOn/);
  });
});

describe('parseRecipient', () => {
  it('splits name and role', () => {
    assert.deepEqual(parseRecipient('Priya Rao, Head of Growth'), { name: 'Priya Rao', role: 'Head of Growth', firstName: 'Priya' });
  });
  it('handles a name only', () => {
    assert.deepEqual(parseRecipient('Priya'), { name: 'Priya', role: undefined, firstName: 'Priya' });
  });
  it('handles nothing', () => {
    assert.deepEqual(parseRecipient('  '), { name: undefined, role: undefined, firstName: undefined });
  });
});

describe('wordCount', () => {
  it('counts across newlines', () => assert.equal(wordCount('Hi there,\n\nthree words here'), 5));
});

describe('fact ids in drafts', () => {
  const ten = new Set(['s1', 's2', 's10']);

  it('asks for a rewrite when the body or subject cites fact ids', () => {
    assert.match(checkEmail(email({ body: `${words(60)} (S1)` }), ids, 0).join(' '), /fact ids/);
    assert.match(checkEmail(email({ subject: 'Your launch, s2' }), ids, 0).join(' '), /fact ids/);
  });

  it('strips bracketed and bare ids and tidies the punctuation left behind', () => {
    assert.equal(stripFactIds('You shipped offline sync (S1), which is rare.', ten), 'You shipped offline sync, which is rare.');
    assert.equal(stripFactIds('Saw your hiring push [s2, S10].', ten), 'Saw your hiring push.');
    assert.equal(stripFactIds('Two things stood out (facts: s1 and s2).\nS10 too.', ten), 'Two things stood out.\ntoo.');
    assert.equal(stripFactIds('Hi Priya,\n\nYour S1 launch.', ten), 'Hi Priya,\n\nYour launch.');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Your Series B and 2 launches in Q1 (both in 2026) stood out.';
    assert.equal(mentionsFactIds(text, ten), false);
    assert.equal(stripFactIds(text, ten), text);
    assert.equal(stripFactIds('We shipped 1 thing (1).', new Set(['1'])), 'We shipped 1 thing.', 'numeric ids only go when bracketed');
  });
});
