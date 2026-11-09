import { safeText } from './format.js';
import type { Logger } from './server.js';
import type { ProgressEvent } from './pipeline.js';
import { createSpinner } from './spinner.js';
import { BRAND, clock, infoRow, renderMasthead, style, type ColorDepth, type Rgb } from './theme.js';

/**
 * Human-friendly output for `iris serve` in an interactive terminal: a startup banner with the
 * Iris masthead and server details, then italic one-line logs.
 * Non-TTY output (Render, Docker, pipes) keeps the JSON logger, so log drains are unaffected.
 */

/** Pretty logs only when a person is watching; IRIS_LOG_FORMAT=json|pretty overrides. */
export function wantsPrettyLogs(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  const format = env.IRIS_LOG_FORMAT?.toLowerCase();
  if (format === 'json') return false;
  if (format === 'pretty') return true;
  return Boolean(stream.isTTY);
}

export interface BannerInfo {
  url: string;
  provider: string;
  model: string;
  version: string;
}

export function renderBanner(info: BannerInfo, depth: ColorDepth): string {
  const s = style(depth);
  const lines = renderMasthead(depth, info.version);
  lines.push(
    `  ${s.dim('─'.repeat(52))}`,
    infoRow(s, BRAND.mint, 'ready', s.bold(s.fg(BRAND.sky, safeText(info.url)))),
    infoRow(s, BRAND.violet, 'model', s.italic(`${safeText(info.provider)} ${s.dim('·')} ${safeText(info.model)}`)),
    infoRow(s, BRAND.glint, 'rule', s.italic(s.dim('every fact is quoted from the source page, or dropped'))),
    `  ${s.dim('─'.repeat(52))}`,
    `  ${s.italic(s.dim('watching for requests  ·  ctrl+c to stop'))}`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

const STATIC_PATH = /\.(css|js|svg|woff2?|png|ico|txt)$/;

function duration(ms: unknown): string {
  if (typeof ms !== 'number') return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const text = (value: unknown) => safeText(String(value ?? ''));

export interface PrettyLoggerOptions {
  depth: ColorDepth;
  write?: (line: string) => void;
  /** Animate a loader on this TTY while runs are in flight. */
  animate?: NodeJS.WriteStream;
  now?: () => Date;
}

/** One italic line per event; the request id tail ties a run to its HTTP request. */
export function createPrettyLogger(options: PrettyLoggerOptions): Logger {
  const s = style(options.depth);
  const spinner = options.animate && options.depth !== 'none' ? createSpinner({ stream: options.animate, depth: options.depth }) : undefined;
  const plainWrite = options.write ?? ((line: string) => process.stdout.write(line));
  const write = (line: string) => (spinner ? spinner.print(line) : plainWrite(line));
  const active = new Map<string, string>();
  const refresh = () => {
    if (!spinner) return;
    const labels = [...active.values()];
    if (labels.length === 0) spinner.stop();
    else spinner.set(labels.length === 1 ? labels[0]! : `${labels.length} runs · ${labels.at(-1)}`);
  };
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
    if (message === 'run' && typeof fields.requestId === 'string' && active.delete(fields.requestId)) refresh();
  };
  return {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    progress(requestId: string, host: string, event: ProgressEvent) {
      if (!spinner) return;
      if (event.stage === 'done') active.delete(requestId);
      else active.set(requestId, `${safeText(host)} · ${event.message}`);
      refresh();
    },
  };
}
