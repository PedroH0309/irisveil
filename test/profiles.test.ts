import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfile, normalizeProfileUrl } from '../src/profiles.js';
import { IrisError } from '../src/errors.js';
import { startSite, testConfig } from './helpers.js';

describe('normalizeProfileUrl', () => {
  it('canonicalises LinkedIn and X profiles', () => {
    assert.equal(normalizeProfileUrl('linkedin', 'linkedin.com/in/priya-rao/?utm=x'), 'https://www.linkedin.com/in/priya-rao');
    assert.equal(normalizeProfileUrl('linkedin', 'https://in.linkedin.com/in/priya-rao'), 'https://www.linkedin.com/in/priya-rao');
    assert.equal(normalizeProfileUrl('x', '@priyarao'), 'https://x.com/priyarao');
    assert.equal(normalizeProfileUrl('x', 'https://twitter.com/priyarao'), 'https://x.com/priyarao');
  });

  it('rejects anything that is not a profile on that network', () => {
    for (const [network, raw] of [
      ['linkedin', 'https://evil.example/in/priya'],
      ['linkedin', 'linkedin.com/company/acme'],
      ['x', 'https://x.com/priyarao/status/1'],
      ['x', 'x.com.evil.example/priyarao'],
    ] as const) {
      assert.throws(() => normalizeProfileUrl(network, raw), (e: unknown) => e instanceof IrisError && e.code === 'INVALID_INPUT', raw);
    }
  });
});

describe('fetchProfile', () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  before(async () => {
    site = await startSite({
      '/in/priya': '<html><head><title>Priya Rao - Head of Growth at Northwind</title></head><body><main><p>Priya leads growth at Northwind Robotics and previously ran field operations at Kestrel Logistics for six years.</p></main></body></html>',
      '/wall': '<html><head><title>Sign in to view this profile</title></head><body><p>Join now to see Priya\'s full profile.</p></body></html>',
    });
  });
  after(() => site.close());

  it('reads a public profile as a source page', async () => {
    const page = await fetchProfile('linkedin', `${site.origin}/in/priya`, testConfig('http://127.0.0.1:1').fetch);
    assert.equal(page.network, 'linkedin');
    assert.match(page.text, /previously ran field operations/);
  });

  it('treats a sign-in wall as unreadable', async () => {
    await assert.rejects(fetchProfile('linkedin', `${site.origin}/wall`, testConfig('http://127.0.0.1:1').fetch));
  });
});
