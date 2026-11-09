import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFailure, renderProgress, renderRunHeader } from '../src/cli-output.js';

const ESC = String.fromCharCode(0x1b);
const info = { target: 'https://linear.app/', recipient: 'Priya Rao, Head of Growth', provider: 'groq', model: 'openai/gpt-oss-120b', version: '1.0.0' };

describe('cli output', () => {
  it('renders the run header with target, recipient and model', () => {
    const plain = renderRunHeader(info, 'none');
    assert.ok(!plain.includes(ESC));
    assert.match(plain, /target\s+https:\/\/linear\.app\//);
    assert.match(plain, /for\s+Priya Rao, Head of Growth/);
    assert.match(plain, /model\s+groq · openai\/gpt-oss-120b/);
    assert.doesNotMatch(renderRunHeader({ ...info, recipient: undefined }, 'none'), /\bfor\b/);
  });

  it('prints each stage as one italic, timestamped line', () => {
    const line = renderProgress({ stage: 'fetch', message: 'Reading linear.app' }, 'truecolor', new Date(2026, 10, 9, 9, 5, 7));
    assert.ok(line.includes(`${ESC}[3m`));
    assert.match(line.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), ''), /^ {2}09:05:07 {2}◆ {2}fetch {4}Reading linear\.app\n$/);
    assert.match(renderProgress({ stage: 'done', message: 'Done' }, 'none'), /✓ {2}done/);
  });

  it('strips control characters from failure text', () => {
    assert.ok(!renderFailure(`bad${ESC}[2J`, undefined, 'none').includes(ESC));
  });
});
