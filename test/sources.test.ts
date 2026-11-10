import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExternalSources, isSameSite, selectSnippets } from '../src/sources.js';
import { startSite, testConfig } from './helpers.js';

const article = (body: string) => `<html><head><title>Wire</title></head><body><main>${body}</main></body></html>`;

describe('isSameSite', () => {
  it('matches the host, www and subdomains, and nothing else', () => {
    assert.ok(isSameSite('https://www.acme.com/news', 'https://acme.com'));
    assert.ok(isSameSite('https://blog.acme.com/x', 'https://acme.com/'));
    assert.ok(!isSameSite('https://acme.com.evil.example/', 'https://acme.com'));
    assert.ok(!isSameSite('https://techwire.example/acme', 'https://acme.com'));
  });
});

describe('selectSnippets', () => {
  it('keeps text under budget untouched', () => {
    assert.deepEqual(selectSnippets('short', ['acme'], 100), { text: 'short', truncated: false });
  });

  it('prefers paragraphs that name the company and keeps their order', () => {
    const text = ['Weather today is mild everywhere.', 'Acme launched a robot.', 'Sports scores follow below.', 'Acme raised money.'].join('\n');
    const out = selectSnippets(text, ['Acme'], 45);
    assert.equal(out.text, 'Acme launched a robot.\nAcme raised money.');
    assert.ok(out.truncated);
  });

  it('is deterministic', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} about Acme and other things.`).join('\n');
    assert.equal(selectSnippets(text, ['acme'], 500).text, selectSnippets(text, ['acme'], 500).text);
  });
});

describe('fetchExternalSources', () => {
  it('tags pages third_party, dedupes syndicated copies and warns on truncation', async () => {
    const story = `<p>Acme Robotics announced a warehouse robot on Tuesday, the company said in a statement.</p>${Array.from({ length: 200 }, (_, i) => `<p>Unrelated filler paragraph ${i} about markets.</p>`).join('')}`;
    const wire = await startSite({ '/a': article(story), '/b': article(story) });
    const company = await startSite({ '/': article('<p>Acme</p>') });
    try {
      const config = testConfig('http://unused');
      const result = await fetchExternalSources([`${wire.origin}/a`, `${wire.origin}/b`], `${company.origin}/`, ['Acme'], {
        ...config.fetch,
        externalBudgetChars: 2_000,
      });
      assert.equal(result.pages.length, 1);
      assert.equal(result.pages[0]!.sourceType, 'third_party');
      assert.ok(result.pages[0]!.retrievedAt);
      assert.ok(result.pages[0]!.text.length <= 1_000);
      assert.match(result.pages[0]!.text, /announced a warehouse robot/);
      assert.match(result.skipped[0]!.reason, /duplicate of/);
      assert.match(result.warnings.join(' '), /trimmed/);
    } finally {
      await wire.close();
      await company.close();
    }
  });

  it("skips a source that redirects back to the company's own site", async () => {
    const company = await startSite({ '/': article('<p>Acme home</p>') });
    const wire = await startSite({ '/r': { status: 302, body: '', headers: { location: `${company.origin}/` } } });
    try {
      const config = testConfig('http://unused');
      const result = await fetchExternalSources([`${wire.origin}/r`], `${company.origin}/`, ['Acme'], { ...config.fetch, externalBudgetChars: 2_000 });
      assert.equal(result.pages.length, 0);
      assert.match(result.skipped[0]!.reason, /company's own site/);
    } finally {
      await wire.close();
      await company.close();
    }
  });

  it('skips sources on private addresses when private hosts are not allowed', async () => {
    const wire = await startSite({ '/a': article('<p>Acme news that is long enough to count as readable text for sure.</p>') });
    try {
      const config = testConfig('http://unused', { IRISVEIL_ALLOW_PRIVATE_HOSTS: 'false' });
      const result = await fetchExternalSources([`${wire.origin}/a`], 'https://acme.example/', ['Acme'], { ...config.fetch, externalBudgetChars: 2_000 });
      assert.equal(result.pages.length, 0);
      assert.equal(result.skipped.length, 1);
    } finally {
      await wire.close();
    }
  });
});
