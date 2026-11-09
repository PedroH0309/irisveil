import { safeText } from './format.js';
import { BRAND, mix, style, type ColorDepth, type Rgb } from './theme.js';

/**
 * The live loader shown while Iris works: a pulsing iris mark, a row of sparkles that twinkle
 * in a violet-to-gold wave, and the current step in italics with a soft light sweeping across it.
 * It redraws one line in place, so other output goes through `print` to land above it.
 */

const SPARKS = ['·', '⋆', '✧', '✦'] as const;
const FIELD = 7;
const WHITE: Rgb = [0xf6, 0xf2, 0xff];

/** One frame of the loader as a single line, no wider than `columns`. Pure, for tests. */
export function renderFrame(text: string, tick: number, elapsedMs: number, depth: ColorDepth, columns = 80): string {
  const s = style(depth);
  const pulse = (Math.sin(tick * 0.25) + 1) / 2;
  const mark = s.fg(mix(BRAND.violet, BRAND.lilac, pulse), '◉');

  let field = '';
  for (let i = 0; i < FIELD; i++) {
    // Two waves at different speeds so the twinkle never looks like a plain marquee.
    const a = (Math.sin(tick * 0.42 - i * 0.95) + 1) / 2;
    const b = (Math.sin(tick * 0.17 + i * 2.3) + 1) / 2;
    const level = a * 0.75 + b * 0.25;
    const glyph = SPARKS[Math.min(SPARKS.length - 1, Math.floor(level * SPARKS.length))]!;
    const color = level > 0.82 ? mix(BRAND.lilac, BRAND.glint, (level - 0.82) / 0.18) : mix(BRAND.violet, BRAND.lilac, level / 0.82);
    field += s.fg(color, glyph);
  }

  const seconds = `${(elapsedMs / 1000).toFixed(1)}s`;
  const room = Math.max(8, columns - FIELD - seconds.length - 10);
  const clean = safeText(text).replace(/\s+/g, ' ');
  const label = clean.length > room ? `${clean.slice(0, room - 1)}…` : clean;

  // A soft highlight travels across the label, then pauses off-screen before the next pass.
  const span = label.length + 14;
  const center = (tick * 0.7) % span - 7;
  let shimmer = '';
  for (let i = 0; i < label.length; i++) {
    const glow = Math.exp(-((i - center) ** 2) / 6);
    shimmer += depth === 'none' ? label[i] : s.fg(mix(BRAND.lilac, WHITE, glow), label[i]!);
  }

  return `  ${mark} ${field}  ${s.italic(shimmer)}  ${s.dim(seconds)}`;
}

export interface Spinner {
  /** Show or update the loader text; starts the animation if it is idle. */
  set(text: string): void;
  /** Write finished output above the loader without tearing it. */
  print(chunk: string): void;
  stop(): void;
  readonly running: boolean;
}

const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';
const CLEAR_LINE = '\r\u001B[2K';

let cursorGuard = false;

export function createSpinner(options: {
  stream: NodeJS.WriteStream;
  depth: ColorDepth;
  intervalMs?: number;
  now?: () => number;
}): Spinner {
  const { stream, depth } = options;
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let text = '';
  let tick = 0;
  let startedAt = 0;

  if (!cursorGuard) {
    cursorGuard = true;
    process.once('exit', () => stream.write(SHOW_CURSOR));
  }

  const draw = () => stream.write(`${CLEAR_LINE}${renderFrame(text, tick, now() - startedAt, depth, stream.columns || 80)}`);

  return {
    get running() {
      return timer !== undefined;
    },
    set(next) {
      text = next;
      if (!timer) {
        startedAt = now();
        stream.write(HIDE_CURSOR);
        timer = setInterval(() => {
          tick += 1;
          draw();
        }, options.intervalMs ?? 80);
        timer.unref();
      }
      draw();
    },
    print(chunk) {
      if (!timer) {
        stream.write(chunk);
        return;
      }
      stream.write(`${CLEAR_LINE}${chunk}`);
      draw();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      stream.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
    },
  };
}
