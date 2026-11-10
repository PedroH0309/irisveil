import { IrisVeilError, isIrisVeilError } from './errors.js';
import { extractDocument } from './extract.js';
import { fetchHtml, isHtml, type FetchOptions, type SourcePage } from './site.js';

/**
 * Opt-in third-party sources: URLs the user supplies explicitly (a press release, a news story).
 * Each goes through the same SSRF-guarded fetcher as the company site, is bounded to a fixed
 * character budget by deterministic snippet selection, and is tagged `third_party` so its facts
 * are never attributed to the company. The model never chooses or browses these URLs itself.
 */

export const MAX_EXTERNAL_SOURCES = 3;

export interface ExternalSourceResult {
  pages: SourcePage[];
  skipped: Array<{ url: string; reason: string }>;
  /** Visible notes about truncation and duplicates. */
  warnings: string[];
  /** Characters dropped across all sources by the budget. */
  droppedChars: number;
}

function host(url: string): string {
  return new URL(url).host.toLowerCase().replace(/^www\./, '');
}

/** True when `candidate` is the company's own host or a subdomain of it. */
export function isSameSite(candidate: string, companyUrl: string): boolean {
  const a = host(candidate);
  const b = host(companyUrl);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 600);
}

/**
 * Keeps the paragraphs most relevant to the company, in their original order, within `budget`.
 * Relevance is a deterministic score: mentions of the company's name terms, then position.
 */
export function selectSnippets(text: string, terms: string[], budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const wanted = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 2);
  const scored = paragraphs.map((p, index) => {
    const lower = p.toLowerCase();
    const hits = wanted.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
    return { p, index, score: hits * 10 - index / paragraphs.length };
  });
  const chosen = new Set<number>();
  let used = 0;
  for (const { p, index } of [...scored].sort((a, b) => b.score - a.score)) {
    if (used + p.length + 1 > budget) continue;
    chosen.add(index);
    used += p.length + 1;
  }
  const kept = paragraphs.filter((_, index) => chosen.has(index));
  if (kept.length === 0) kept.push(paragraphs[0]!.slice(0, budget));
  return { text: kept.join('\n'), truncated: true };
}

export async function fetchExternalSources(
  urls: string[],
  companyUrl: string,
  companyTerms: string[],
  options: FetchOptions & { externalBudgetChars: number },
): Promise<ExternalSourceResult> {
  const result: ExternalSourceResult = { pages: [], skipped: [], warnings: [], droppedChars: 0 };
  if (urls.length === 0) return result;
  const perSource = Math.floor(options.externalBudgetChars / urls.length);
  const seen = new Map<string, string>();

  const fetched = await Promise.allSettled(
    urls.map(async (url) => {
      const page = await fetchHtml(url, options);
      if (page.status >= 400) throw new IrisVeilError('FETCH_FAILED', `HTTP ${page.status}`);
      if (!isHtml(page.contentType)) throw new IrisVeilError('NOT_HTML', 'not HTML');
      // A redirect can land back on the company's own site; that is not independent.
      if (isSameSite(page.url, companyUrl)) throw new IrisVeilError('INVALID_INPUT', "it is on the company's own site");
      return { url: page.url, doc: extractDocument(page.html), retrievedAt: new Date().toISOString() };
    }),
  );
  if (options.signal?.aborted) throw new IrisVeilError('ABORTED', 'The run was cancelled.');

  fetched.forEach((outcome, index) => {
    const requested = urls[index]!;
    if (outcome.status === 'rejected') {
      result.skipped.push({ url: requested, reason: isIrisVeilError(outcome.reason) ? outcome.reason.message : 'failed' });
      return;
    }
    const { url, doc, retrievedAt } = outcome.value;
    const key = fingerprint(doc.text);
    const duplicateOf = seen.get(key);
    if (duplicateOf) {
      result.skipped.push({ url: requested, reason: `duplicate of ${duplicateOf}` });
      return;
    }
    if (doc.text.length < 80) {
      result.skipped.push({ url: requested, reason: 'almost no readable text' });
      return;
    }
    seen.set(key, url);
    const selected = selectSnippets(doc.text, companyTerms, perSource);
    if (selected.truncated) {
      result.droppedChars += doc.text.length - selected.text.length;
      result.warnings.push(`${host(url)} was trimmed to its ${selected.text.length.toLocaleString('en-US')} most relevant characters.`);
    }
    result.pages.push({
      url,
      title: doc.title.slice(0, 200),
      description: doc.description.slice(0, 400),
      text: selected.text,
      sourceType: 'third_party',
      retrievedAt,
    });
  });
  return result;
}
