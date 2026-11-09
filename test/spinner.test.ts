import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSpinner, renderFrame } from '../src/spinner.js';
import { createPrettyLogger } from '../src/terminal-log.js';

const ESC = String.fromCharCode(0x1b);

function fakeTty() {
  const chunks: string[] = [];
  const stream = { columns: 80, isTTY: true, write: (chunk: string) => chunks.push(chunk) > 0 } as unknown as NodeJS.WriteStream;
  return { stream, chunks, text: () => chunks.join('') };
}

describe('loader', () => {
  it('renders one line that fits the terminal and keeps untrusted text inert', () => {
    const frame = renderFrame(`Reading ${'x'.repeat(200)}${ESC}[2J`, 3, 1500, 'none', 60);
    assert.ok(!frame.includes(ESC));
    assert.ok(!frame.includes('\n'));
    assert.ok(frame.length <= 60, `frame is ${frame.length} wide`);
    assert.match(frame, /◉ .{7} {2}Reading x+… {2}1\.5s$/);
  });

  it('animates with brand colours and italics when colour is on', () => {
    const frame = renderFrame('Reading linear.app', 4, 0, 'truecolor');
    assert.ok(frame.includes(`${ESC}[3m`));
    assert.ok(frame.includes(`${ESC}[38;2;`));
  });

  it('prints finished lines above the loader and restores the cursor on stop', () => {
    const tty = fakeTty();
    const spinner = createSpinner({ stream: tty.stream, depth: 'none', intervalMs: 10_000 });
    spinner.set('Reading linear.app');
    assert.equal(spinner.running, true);
    spinner.print('done line\n');
    spinner.stop();
    assert.equal(spinner.running, false);
    const out = tty.text();
    assert.ok(out.includes('\r' + ESC + '[2Kdone line\n'), 'clears the loader before printing');
    assert.ok(out.endsWith(`${ESC}[?25h`), 'cursor shown again');
  });

  it('runs on the server while a run is in flight and stops when it is logged', () => {
    const tty = fakeTty();
    const logger = createPrettyLogger({ depth: '256', animate: tty.stream });
    const plain = () => tty.text().replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    logger.progress!('abc', 'linear.app', { stage: 'fetch', message: 'Reading linear.app' });
    assert.match(plain(), /linear\.app · Reading linear\.app/);
    logger.info('run', { requestId: 'abc', host: 'linear.app', outcome: 'ok', cached: false, ms: 10, pages: 1, signalsVerified: 1, signalsProposed: 1, emails: 3, tokens: 9 });
    assert.ok(tty.text().endsWith(`${ESC}[?25h`), 'loader stopped after the run line');
  });
});
