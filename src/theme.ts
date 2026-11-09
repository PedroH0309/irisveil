/**
 * Shared terminal look for Iris: brand colours, ANSI styling that degrades from truecolor to
 * 256 colours to plain text, and the masthead (the favicon rasterized into half-block pixels
 * beside the wordmark). Used by the CLI run output and the `iris serve` banner.
 */

export type Rgb = readonly [number, number, number];

export const BRAND = {
  violet: [0x5b, 0x3f, 0xd6],
  lilac: [0xa8, 0x94, 0xff],
  ink: [0x23, 0x1d, 0x3b],
  glint: [0xff, 0xf2, 0x7a],
  mint: [0x5f, 0xd6, 0x9b],
  amber: [0xff, 0xc8, 0x57],
  coral: [0xff, 0x6b, 0x7a],
  sky: [0x6c, 0xb8, 0xff],
  mist: [0x8a, 0x86, 0x9e],
} as const satisfies Record<string, Rgb>;

export type ColorDepth = 'none' | '256' | 'truecolor';

export function colorDepth(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): ColorDepth {
  const forced = env.FORCE_COLOR && env.FORCE_COLOR !== '0';
  if (!forced && (!stream.isTTY || env.NO_COLOR || env.TERM === 'dumb')) return 'none';
  return /truecolor|24bit/i.test(env.COLORTERM ?? '') ? 'truecolor' : '256';
}

function to256([r, g, b]: Rgb): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

export interface Style {
  fg(rgb: Rgb, s: string): string;
  /** Upper half block: `top` colors the upper pixel, `bottom` the lower one; null leaves the terminal background. */
  pixel(top: Rgb | null, bottom: Rgb | null): string;
  italic(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

export function style(depth: ColorDepth): Style {
  const color = (layer: 38 | 48, rgb: Rgb) =>
    depth === 'truecolor' ? `\u001B[${layer};2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\u001B[${layer};5;${to256(rgb)}m`;
  const sgr = (open: number, close: number) => (s: string) => (depth === 'none' ? s : `\u001B[${open}m${s}\u001B[${close}m`);
  return {
    fg: (rgb, s) => (depth === 'none' ? s : `${color(38, rgb)}${s}\u001B[39m`),
    pixel(top, bottom) {
      if (depth === 'none') return top || bottom ? '█' : ' ';
      if (!top && !bottom) return ' ';
      if (top && !bottom) return `${color(38, top)}▀\u001B[39m`;
      if (!top && bottom) return `${color(38, bottom)}▄\u001B[39m`;
      return `${color(38, top!)}${color(48, bottom!)}▀\u001B[39;49m`;
    },
    italic: sgr(3, 23),
    bold: sgr(1, 22),
    dim: sgr(2, 22),
  };
}

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

/** The favicon geometry (32×32 viewBox): outer ring, filled iris, dark pupil, yellow glint. */
function logoPixel(x: number, y: number): Rgb | null {
  const d = Math.hypot(x - 16, y - 16);
  if (Math.hypot(x - 13.5, y - 13.5) <= 1.6) return BRAND.glint;
  if (d <= 3.6) return BRAND.ink;
  if (d <= 8.2) return mix(BRAND.lilac, BRAND.violet, (d - 3.6) / 4.6);
  if (d >= 12.4 && d <= 15.6) return mix(BRAND.lilac, BRAND.violet, y / 32);
  return null;
}

/** Rasterizes the mark at `size` pixels square; returns size/2 rows of `size` cells. */
function renderLogo(s: Style, size: number): string[] {
  const rows: string[] = [];
  const sample = (px: number, py: number) => logoPixel(((px + 0.5) * 32) / size, ((py + 0.5) * 32) / size);
  for (let py = 0; py < size; py += 2) {
    let row = '';
    for (let px = 0; px < size; px++) row += s.pixel(sample(px, py), sample(px, py + 1));
    rows.push(row);
  }
  return rows;
}

const WORDMARK = [
  '██╗██████╗ ██╗███████╗',
  '██║██╔══██╗██║██╔════╝',
  '██║██████╔╝██║███████╗',
  '██║██╔══██╗██║╚════██║',
  '██║██║  ██║██║███████║',
  '╚═╝╚═╝  ╚═╝╚═╝╚══════╝',
];

/** Logo, wordmark, tagline and byline, as lines ready to print. */
export function renderMasthead(depth: ColorDepth, version: string): string[] {
  const s = style(depth);
  const logo = depth === 'none' ? [] : renderLogo(s, 24);
  const word = WORDMARK.map((line, i) => s.bold(s.fg(mix(BRAND.lilac, BRAND.violet, i / (WORDMARK.length - 1)), line)));
  const right = [
    '',
    ...word,
    '',
    s.italic(s.fg(BRAND.lilac, 'Cold emails built on facts you can check.')),
    s.italic(s.dim(`by YourAKShaw  ·  v${version}`)),
    '',
  ];
  const height = Math.max(logo.length, right.length);
  const blank = ' '.repeat(24);
  const lines: string[] = [''];
  for (let i = 0; i < height; i++) {
    const left = logo.length ? `  ${logo[i] ?? blank}    ` : '  ';
    lines.push(`${left}${right[i] ?? ''}`.trimEnd());
  }
  return lines;
}

/** A "● label   value" row under the masthead. */
export function infoRow(s: Style, dot: Rgb, label: string, value: string): string {
  return `  ${s.fg(dot, '●')} ${s.italic(s.dim(label.padEnd(9)))} ${value}`;
}

export function clock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
