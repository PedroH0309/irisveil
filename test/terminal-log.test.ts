import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPrettyLogger, renderBanner, wantsPrettyLogs } from '../src/terminal-log.js';
import { colorDepth } from '../src/theme.js';

const ESC = String.fromCharCode(0x1b);
const info = { url: 'http://127.0.0.1:3000', provider: 'groq', model: 'openai/gpt-oss-120b', version: '1.0.0' };

function capture(depth: 'none' | 'truecolor') {
  const lines: string[] = [];
  const logger = createPrettyLogger({ depth, write: (line) => lines.push(line), now: () => new Date(2026, 10, 9, 12, 50, 26) });
  return { lines, logger };
}

describe('terminal logs', () => {
  it('chooses pretty logs only for a TTY unless IRISVEIL_LOG_FORMAT overrides', () => {
    assert.equal(wantsPrettyLogs({ isTTY: true }, {}), true);
    assert.equal(wantsPrettyLogs({ isTTY: false }, {}), false);
    assert.equal(wantsPrettyLogs({ isTTY: true }, { IRISVEIL_LOG_FORMAT: 'json' }), false);
    assert.equal(wantsPrettyLogs({ isTTY: false }, { IRISVEIL_LOG_FORMAT: 'pretty' }), true);
  });

  it('detects color depth and honours NO_COLOR', () => {
    assert.equal(colorDepth({ isTTY: true }, { COLORTERM: 'truecolor' }), 'truecolor');
    assert.equal(colorDepth({ isTTY: true }, {}), '256');
    assert.equal(colorDepth({ isTTY: true }, { NO_COLOR: '1' }), 'none');
    assert.equal(colorDepth({ isTTY: false }, {}), 'none');
  });

  it('renders the banner with server details and no escapes when color is off', () => {
    const plain = renderBanner(info, 'none');
    assert.ok(!plain.includes(ESC));
    assert.match(plain, /http:\/\/127\.0\.0\.1:3000/);
    assert.match(plain, /groq · openai\/gpt-oss-120b/);
    assert.ok(renderBanner(info, 'truecolor').includes(`${ESC}[38;2;`));
  });

  it('prints requests and runs as single italic lines', () => {
    const { lines, logger } = capture('truecolor');
    logger.info('listening', info);
    logger.info('request', { requestId: 'ffec44ff-afbc', method: 'POST', path: '/api/runs', status: 200, ms: 6105 });
    assert.equal(lines.length, 1, 'listening is shown by the banner instead');
    assert.ok(lines[0]!.includes(`${ESC}[3m`), 'italic');
    assert.ok(lines[0]!.endsWith('\n') && !lines[0]!.slice(0, -1).includes('\n'));
  });

  it('summarizes runs and strips control characters from third-party text', () => {
    const { lines, logger } = capture('none');
    logger.info('run', { requestId: 'ffec44ff-afbc', host: 'wayground.com', outcome: 'ok', cached: false, ms: 6078, pages: 4, signalsVerified: 6, signalsProposed: 7, emails: 3, tokens: 4729 });
    logger.warn('run', { host: 'evil.test', outcome: 'FETCH_FAILED', ms: 10, detail: `boom${ESC}[31m` });
    assert.match(lines[0]!, /12:50:26 .*research wayground\.com .*6\/7 facts verified .*4,729 tokens .*#ffec44ff/);
    assert.ok(!lines[1]!.includes(ESC));
    assert.match(lines[1]!, /▲ .*FETCH_FAILED/);
  });
});
