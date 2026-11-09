import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentClient, flattenMessages } from '../src/local-agent.js';
import { loadConfig } from '../src/config.js';
import { IrisError } from '../src/errors.js';

describe('local agent CLIs', () => {
  let bin: string;
  const originalPath = process.env.PATH;

  before(async () => {
    bin = await mkdtemp(join(tmpdir(), 'iris-fake-bin-'));
    // A stand-in for `claude -p <prompt> ...`: echoes its argument count and whether tools are off.
    await writeFile(
      join(bin, 'claude'),
      '#!/bin/sh\nif [ "$2" = "fail" ]; then echo "not signed in" >&2; exit 1; fi\nif [ "$2" = "slow" ]; then sleep 5; fi\nprintf \'{"ok":true,"tools":"%s"}\' "$6"\n',
    );
    await chmod(join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
  });

  after(async () => {
    process.env.PATH = originalPath;
    await rm(bin, { recursive: true, force: true });
  });

  it('flattens a chat into one prompt with labelled turns', () => {
    const text = flattenMessages([
      { role: 'system', content: 'Rules.' },
      { role: 'user', content: 'Page text.' },
      { role: 'assistant', content: '{}' },
      { role: 'user', content: 'Fix it.' },
    ]);
    assert.equal(text, 'Rules.\n\n[USER]\nPage text.\n\n[ASSISTANT]\n{}\n\n[USER]\nFix it.');
  });

  it('returns the CLI answer with tools turned off', async () => {
    const client = createAgentClient('claude', { timeoutMs: 5_000 });
    assert.equal(client.provider, 'Claude Code');
    const result = await client.complete([{ role: 'user', content: 'hi' }], { maxTokens: 100 });
    assert.equal(result.text, '{"ok":true,"tools":""}');
    assert.ok(result.usage.promptTokens > 0);
  });

  it('reports a failing, slow or missing CLI clearly', async () => {
    const client = createAgentClient('claude', { timeoutMs: 1_000 });
    const isUnavailable = (e: unknown) => e instanceof IrisError && e.code === 'LLM_UNAVAILABLE';
    await assert.rejects(client.complete([{ role: 'system', content: 'fail' }], { maxTokens: 1 }), isUnavailable);
    await assert.rejects(client.complete([{ role: 'system', content: 'slow' }], { maxTokens: 1 }), /did not answer within 1 seconds/);
    process.env.PATH = bin; // only the fake claude exists, so `grok` is missing
    try {
      await assert.rejects(
        createAgentClient('grok', { timeoutMs: 1_000 }).complete([{ role: 'user', content: 'x' }], { maxTokens: 1 }),
        /The grok command was not found/,
      );
    } finally {
      process.env.PATH = `${bin}:${originalPath}`;
    }
  });

  it('does not require an API key when a local CLI is used', () => {
    assert.throws(() => loadConfig({}), /--claude, --codex, --antigravity or --grok/);
    const config = loadConfig({}, { localAgent: true });
    assert.equal(config.llm.timeoutMs, 240_000);
    assert.equal(config.runTimeoutMs, 600_000);
  });
});
