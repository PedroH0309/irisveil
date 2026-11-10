/**
 * Deterministic claim–evidence guards.
 *
 * A quote being present on the page proves provenance, not support. These rules catch
 * high-precision contradictions between a claim and its own quote: flipped negation,
 * scope that exceeds an "only" qualifier, and numerical bounds that point the other way.
 * A rule miss is not proof of support; it only means the guard could not decide.
 */

export type ClaimVerdict = 'supported' | 'contradicted' | 'insufficient_evidence';

export interface GuardResult {
  verdict: 'contradicted' | 'unresolved';
  reason?: string;
}

export const DETERMINISTIC_VALIDATOR = 'deterministic-guards@1';

const NEGATION = /\b(?:not|no|never|none|nor|without|cannot|neither)\b|n't\b/g;
const NEGATION_WORD = /^(?:not|no|never|none|nor|without|cannot|neither)$/;
const STOPWORDS = new Set(
  'a an the and or of to in on for with by at from as is are was were be been we our us they their it its this that these those do does did serve serves'.split(' '),
);
const BROAD_SCOPE = /\b(?:worldwide|globally|global|everywhere|international(?:ly)?|all (?:countries|markets|regions))\b/;
const ONLY = /\b(?:only|exclusively|solely)\b/;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ`]/g, "'");
}

function negationCount(text: string): number {
  const idioms = normalise(text).replace(/\b(?:no (?:more|less|fewer) than|not only|no matter)\b/g, ' ');
  return idioms.match(NEGATION)?.length ?? 0;
}

function contentWords(text: string): Set<string> {
  return new Set(
    normalise(text)
      .replace(/n't\b/g, ' ')
      .split(/[^a-z0-9$%]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !NEGATION_WORD.test(word)),
  );
}

/** Share of the claim's content words that also appear in the quote. */
function overlap(claim: string, quote: string): number {
  const claimWords = contentWords(claim);
  if (claimWords.size === 0) return 0;
  const quoteWords = contentWords(quote);
  let shared = 0;
  for (const word of claimWords) if (quoteWords.has(word)) shared++;
  return shared / claimWords.size;
}

type Bound = { kind: 'max' | 'min'; value: number };

function bounds(text: string): Bound[] {
  const found: Bound[] = [];
  const pattern = /\b(up to|at most|maximum of|no more than|max\.?|more than|over|at least|minimum of|beyond|unlimited)\s*\$?(\d[\d,]*(?:\.\d+)?)?/g;
  for (const match of normalise(text).matchAll(pattern)) {
    const phrase = match[1]!;
    if (phrase === 'unlimited') {
      found.push({ kind: 'min', value: Number.POSITIVE_INFINITY });
      continue;
    }
    if (!match[2]) continue;
    const value = Number(match[2].replace(/,/g, ''));
    const kind = /up to|at most|maximum|no more than|max/.test(phrase) ? 'max' : 'min';
    found.push({ kind, value });
  }
  return found;
}

export function checkClaimAgainstQuote(claim: string, quote: string): GuardResult {
  const related = overlap(claim, quote) >= 0.5;

  if (related && negationCount(claim) % 2 !== negationCount(quote) % 2) {
    return { verdict: 'contradicted', reason: 'claim reverses the negation in its quote' };
  }

  const claimText = normalise(claim);
  const quoteText = normalise(quote);
  if (ONLY.test(quoteText) && BROAD_SCOPE.test(claimText) && !BROAD_SCOPE.test(quoteText)) {
    return { verdict: 'contradicted', reason: 'claim broadens a scope the quote restricts with "only"' };
  }

  for (const q of bounds(quote)) {
    for (const c of bounds(claim)) {
      if (q.kind === 'max' && c.kind === 'min' && c.value >= q.value) {
        return { verdict: 'contradicted', reason: `claim exceeds the quote's upper bound of ${q.value}` };
      }
      if (q.kind === 'min' && c.kind === 'max' && c.value <= q.value) {
        return { verdict: 'contradicted', reason: `claim falls below the quote's lower bound of ${q.value}` };
      }
    }
  }

  return { verdict: 'unresolved' };
}
