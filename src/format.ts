import type { IrisVeilResult } from './pipeline.js';
import { charClass } from './chars.js';
import { BRAND, style, type ColorDepth } from './theme.js';

/**
 * Renders results for the terminal and as Markdown.
 * All text originates from a third-party website or a model, so terminal output strips
 * control characters (ANSI escape injection) before adding IrisVeil's own styling.
 */

const CONTROL_CHARS = charClass([
  [0x00, 0x08], // C0 controls except tab and newline
  [0x0b, 0x1f], // includes ESC, which starts ANSI sequences
  [0x7f, 0x9f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width and directional marks
  [0x2028, 0x202e], // line/paragraph separators, bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
]);

export function safeText(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

function wrapText(text: string, width: number, indent = ''): string {
  return text
    .split('\n')
    .map((paragraph) => {
      if (!paragraph.trim()) return '';
      const lines: string[] = [];
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && line.length + word.length + 1 > width) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) lines.push(line);
      return lines.map((l) => indent + l).join('\n');
    })
    .join('\n');
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

/**
 * The research brief for a terminal. Email subjects and bodies stay plain (no gutter, no box)
 * so they can be selected and pasted straight into a mail client.
 */
export function renderTerminal(result: IrisVeilResult, options: { depth: ColorDepth; width?: number }): string {
  const s = style(options.depth);
  const width = Math.max(50, Math.min(options.width ?? 88, 100));
  const t = safeText;
  const out: string[] = [];
  const heading = (title: string, note: string) => `  ${s.bold(s.fg(BRAND.lilac, title))}  ${s.italic(s.dim(note))}`;
  const rule = (label: string, meta: string) => {
    const fill = Math.max(4, Math.min(width, 76) - label.length - meta.length - 9);
    return `  ${s.fg(BRAND.violet, '──')} ${s.bold(label)} ${s.fg(BRAND.violet, '─'.repeat(fill))} ${s.italic(s.dim(meta))}`;
  };

  out.push('');
  out.push(`  ${s.fg(BRAND.violet, '◆')} ${s.bold(s.fg(BRAND.sky, t(result.company.name)))}`);
  out.push(s.italic(s.fg(BRAND.lilac, wrapText(t(result.company.oneLiner), width - 4, '    '))));
  out.push('');

  out.push(heading('VERIFIED FACTS', `${result.stats.signalsVerified} of ${result.stats.signalsProposed} claims matched the source text`));
  out.push('');
  for (const signal of result.signals) {
    out.push(`  ${s.fg(BRAND.mint, '✓')} ${s.fg(BRAND.glint, signal.id.padEnd(3))} ${s.dim(signal.category.padEnd(11))} ${t(signal.claim)}`);
    out.push(s.italic(s.dim(wrapText(`“${t(signal.quote)}” — ${shortUrl(signal.sourceUrl)}`, width - 8, '                    '))));
  }
  if (result.dropped.length) {
    out.push(`  ${s.fg(BRAND.coral, '✗')} ${s.italic(s.fg(BRAND.coral, `${result.dropped.length} claim(s) dropped: quote missing or contradicted`))}`);
  }
  out.push('');

  if (result.hypotheses.length) {
    out.push(heading('HYPOTHESES', 'inferences, not facts'));
    out.push('');
    for (const h of result.hypotheses) {
      out.push(s.italic(s.fg(BRAND.amber, wrapText(`? ${t(h.statement)} (${h.basedOn.join(', ')} · ${h.confidence})`, width, '  '))));
    }
    out.push('');
  }

  result.emails.forEach((email, index) => {
    out.push(rule(`Email ${index + 1} · ${t(email.angle)}`, `uses ${email.basedOn.join(', ')} · ${email.wordCount} words`));
    out.push('');
    out.push(`${s.dim('Subject:')} ${s.bold(t(email.subject))}`);
    out.push('');
    // No hard wrapping: the terminal soft-wraps, so a copied paragraph stays one line.
    out.push(t(email.body));
    out.push('');
  });

  for (const warning of result.warnings) out.push(`  ${s.fg(BRAND.amber, '▲')} ${s.italic(s.fg(BRAND.amber, t(warning)))}`);
  const tokens = result.stats.promptTokens + result.stats.completionTokens;
  out.push(`  ${s.fg(BRAND.violet, '─'.repeat(Math.min(width, 76) - 2))}`);
  out.push(s.italic(s.dim(wrapText(`sources  ${result.sources.map((src) => shortUrl(src.url)).join('  ·  ')}`, width - 4, '  '))));
  out.push(
    s.italic(
      s.dim(
        `  ${result.stats.model} via ${result.stats.provider}  ·  ${result.stats.pagesRead} pages  ·  ` +
          `${tokens.toLocaleString('en-US')} tokens  ·  ${(result.stats.durationMs / 1000).toFixed(1)}s`,
      ),
    ),
  );
  out.push('');
  return out.join('\n');
}

export function renderMarkdown(result: IrisVeilResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.company.name}: outreach brief`);
  lines.push('');
  lines.push(`> ${result.company.oneLiner}`);
  lines.push('');
  lines.push(`Generated by IrisVeil on ${result.generatedAt} from <${result.input.url}>.`);
  lines.push('');
  lines.push(`## Verified facts (${result.stats.signalsVerified} of ${result.stats.signalsProposed})`);
  lines.push('');
  for (const s of result.signals) {
    lines.push(`- **${s.id} · ${s.category}:** ${s.claim}  `);
    lines.push(`  “${s.quote}” ([source](${s.sourceUrl}))`);
  }
  if (result.hypotheses.length) {
    lines.push('');
    lines.push('## Hypotheses (inferences, not facts)');
    lines.push('');
    for (const h of result.hypotheses) lines.push(`- ${h.statement} _(based on ${h.basedOn.join(', ')}; ${h.confidence} confidence)_`);
  }
  lines.push('');
  lines.push('## Drafts');
  result.emails.forEach((email, index) => {
    lines.push('');
    lines.push(`### Email ${index + 1}: ${email.angle}`);
    lines.push('');
    lines.push(`**Subject:** ${email.subject}  `);
    lines.push(`_Uses ${email.basedOn.join(', ')} · ${email.wordCount} words_`);
    lines.push('');
    lines.push('```text');
    lines.push(email.body);
    lines.push('```');
  });
  if (result.warnings.length) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('---');
  lines.push(
    `Model: ${result.stats.model} (${result.stats.provider}) · Pages read: ${result.stats.pagesRead} · ` +
      `Duration: ${(result.stats.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  return lines.join('\n');
}
