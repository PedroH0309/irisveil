import { safeText } from './format.js';
import type { ProgressEvent, Stage } from './pipeline.js';
import { BRAND, clock, infoRow, renderMasthead, style, type ColorDepth, type Rgb } from './theme.js';

/**
 * Decoration for a one-off `iris <url>` run in a terminal: the masthead with what is being
 * researched, then one italic line per pipeline stage. All of it goes to stderr, so stdout
 * stays clean for `--json` and pipes.
 */

export interface RunHeaderInfo {
  target: string;
  recipient: string | undefined;
  provider: string;
  model: string;
  version: string;
}

export function renderRunHeader(info: RunHeaderInfo, depth: ColorDepth): string {
  const s = style(depth);
  const lines = renderMasthead(depth, info.version);
  lines.push(
    `  ${s.dim('─'.repeat(52))}`,
    infoRow(s, BRAND.mint, 'target', s.bold(s.fg(BRAND.sky, safeText(info.target)))),
  );
  if (info.recipient) lines.push(infoRow(s, BRAND.glint, 'for', s.italic(safeText(info.recipient))));
  lines.push(
    infoRow(s, BRAND.violet, 'model', s.italic(`${safeText(info.provider)} ${s.dim('·')} ${safeText(info.model)}`)),
    `  ${s.dim('─'.repeat(52))}`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

const STAGE_COLOR: Record<Stage, Rgb> = {
  fetch: BRAND.sky,
  research: BRAND.violet,
  verify: BRAND.glint,
  draft: BRAND.lilac,
  done: BRAND.mint,
};

export function renderProgress(event: ProgressEvent, depth: ColorDepth, now: Date = new Date()): string {
  const s = style(depth);
  const color = STAGE_COLOR[event.stage] ?? BRAND.lilac;
  const mark = s.fg(color, event.stage === 'done' ? '✓' : '◆');
  const stage = s.fg(color, event.stage.padEnd(8));
  return `  ${s.dim(clock(now))}  ${mark}  ${s.italic(`${stage} ${safeText(event.message)}`)}\n`;
}

export function renderNote(message: string, depth: ColorDepth): string {
  const s = style(depth);
  return `  ${s.fg(BRAND.mint, '✓')}  ${s.italic(s.dim(safeText(message)))}\n`;
}

export function renderFailure(message: string, detail: string | undefined, depth: ColorDepth): string {
  const s = style(depth);
  const extra = detail ? `\n     ${s.italic(s.dim(`detail: ${safeText(detail)}`))}` : '';
  return `  ${s.fg(BRAND.coral, '✖')}  ${s.italic(s.fg(BRAND.coral, safeText(message)))}${extra}\n`;
}
