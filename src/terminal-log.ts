import { safeText } from './format.js';
import type { Logger } from './server.js';

/**
 * Human-friendly output for `iris serve` in an interactive terminal: a startup banner that
 * draws the Iris mark (the favicon, rasterized into half-block pixels) and italic one-line logs.
 * Non-TTY output (Render, Docker, pipes) keeps the JSON logger, so log drains are unaffected.
 */

type Rgb = readonly [number, number, number];

const BRAND = {
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

/** Pretty logs only when a person is watching; IRIS_LOG_FORMAT=json|pretty overrides. */
export function wantsPrettyLogs(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  const format = env.IRIS_LOG_FORMAT?.toLowerCase();
  if (format === 'json') return false;
  if (format === 'pretty') return true;
  return Boolean(stream.isTTY);
}

function to256([r, g, b]: Rgb): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

interface Style {
  fg(rgb: Rgb, s: string): string;
  /** Upper half block: `top` colors the upper pixel, `bottom` the lower one; null leaves the terminal background. */
  pixel(top: Rgb | null, bottom: Rgb | null): string;
  italic(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

function style(depth: ColorDepth): Style {
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

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

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

export interface BannerInfo {
  url: string;
  provider: string;
  model: string;
  version: string;
}

export function renderBanner(info: BannerInfo, depth: ColorDepth): string {
  const s = style(depth);
  const logo = depth === 'none' ? [] : renderLogo(s, 24);
  const word = WORDMARK.map((line, i) => s.bold(s.fg(mix(BRAND.lilac, BRAND.violet, i / (WORDMARK.length - 1)), line)));
  const right = [
    '',
    ...word,
    '',
    s.italic(s.fg(BRAND.lilac, 'Cold emails built on facts you can check.')),
    s.italic(s.dim(`by NayaManas  ·  v${info.version}`)),
    '',
  ];
  const height = Math.max(logo.length, right.length);
  const blank = ' '.repeat(24);
  const lines: string[] = [''];
  for (let i = 0; i < height; i++) {
    const left = logo.length ? `  ${logo[i] ?? blank}    ` : '  ';
    lines.push(`${left}${right[i] ?? ''}`.trimEnd());
  }

  const key = (label: string) => s.italic(s.dim(label.padEnd(9)));
  const dot = (rgb: Rgb) => s.fg(rgb, '●');
  lines.push(
    `  ${s.dim('─'.repeat(52))}`,
    `  ${dot(BRAND.mint)} ${key('ready')} ${s.bold(s.fg(BRAND.sky, safeText(info.url)))}`,
    `  ${dot(BRAND.violet)} ${key('model')} ${s.italic(`${safeText(info.provider)} ${s.dim('·')} ${safeText(info.model)}`)}`,
    `  ${dot(BRAND.glint)} ${key('rule')} ${s.italic(s.dim('every fact is quoted from the source page, or dropped'))}`,
    `  ${s.dim('─'.repeat(52))}`,
    `  ${s.italic(s.dim('watching for requests  ·  ctrl+c to stop'))}`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

const STATIC_PATH = /\.(css|js|svg|woff2?|png|ico|txt)$/;

function clock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function duration(ms: unknown): string {
  if (typeof ms !== 'number') return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const text = (value: unknown) => safeText(String(value ?? ''));

export interface PrettyLoggerOptions {
  depth: ColorDepth;
  write?: (line: string) => void;
  now?: () => Date;
}

/** One italic line per event; the request id tail ties a run to its HTTP request. */
export function createPrettyLogger(options: PrettyLoggerOptions): Logger {
  const s = style(options.depth);
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? (() => new Date());

  const levelMark: Record<string, string> = {
    info: s.fg(BRAND.violet, '◆'),
    warn: s.fg(BRAND.amber, '▲'),
    error: s.fg(BRAND.coral, '✖'),
  };
  const id = (fields: Record<string, unknown>) =>
    typeof fields.requestId === 'string' ? `  ${s.dim(`#${text(fields.requestId).slice(0, 8)}`)}` : '';

  function statusColor(status: number): Rgb {
    if (status >= 500) return BRAND.coral;
    if (status >= 400) return BRAND.amber;
    if (status >= 300) return BRAND.sky;
    return BRAND.mint;
  }

  function request(f: Record<string, unknown>): string {
    const path = text(f.path);
    const quiet = STATIC_PATH.test(path);
    const status = Number(f.status);
    const method = text(f.method).padEnd(8);
    const body = `${s.fg(BRAND.lilac, method)} ${(quiet ? s.dim : (v: string) => v)(path.padEnd(28))} ${s.fg(statusColor(status), String(status))}  ${s.dim(duration(f.ms).padStart(6))}`;
    return quiet ? s.dim(body) : body;
  }

  function run(f: Record<string, unknown>): string {
    const host = s.bold(s.fg(BRAND.sky, text(f.host)));
    if (f.outcome !== 'ok') {
      const detail = f.detail ? `  ${s.dim(text(f.detail))}` : '';
      return `${s.fg(BRAND.coral, 'research')} ${host}  ${s.fg(BRAND.coral, `✗ ${text(f.outcome)}`)}  ${s.dim(duration(f.ms))}${detail}`;
    }
    if (f.cached) return `${s.fg(BRAND.glint, 'research')} ${host}  ${s.fg(BRAND.mint, '✓')} ${s.dim('served from cache')}`;
    const sep = s.dim('  ·  ');
    const parts = [
      `${f.pages} pages`,
      `${s.fg(BRAND.mint, `${f.signalsVerified}/${f.signalsProposed}`)} facts verified`,
      `${f.emails} drafts`,
      `${Number(f.tokens).toLocaleString('en-US')} tokens`,
    ];
    return `${s.fg(BRAND.glint, 'research')} ${host}  ${s.fg(BRAND.mint, '✓')} ${s.dim(duration(f.ms))}${sep}${parts.join(sep)}`;
  }

  function generic(message: string, f: Record<string, unknown>): string {
    const extras = Object.entries(f)
      .filter(([k]) => k !== 'requestId')
      .map(([k, v]) => `${s.dim(`${k}=`)}${text(typeof v === 'object' ? JSON.stringify(v) : v)}`);
    return [text(message), ...extras].join('  ');
  }

  const log = (level: string) => (message: string, fields: Record<string, unknown> = {}) => {
    if (message === 'listening') return; // the banner already says it
    const body = message === 'request' ? request(fields) : message === 'run' ? run(fields) : generic(message, fields);
    write(`  ${s.dim(clock(now()))}  ${levelMark[level] ?? '•'}  ${s.italic(body)}${id(fields)}\n`);
  };
  return { info: log('info'), warn: log('warn'), error: log('error') };
}
