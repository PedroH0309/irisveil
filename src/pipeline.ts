import { z } from 'zod';
import { IrisError, toIrisError } from './errors.js';
import { LIMITS, type IrisConfig } from './config.js';
import { crawlSite } from './site.js';
import { researchCompany, type CompanyProfile, type DroppedClaim, type Hypothesis, type Signal } from './research.js';
import { draftOutreach, parseRecipient, type OutreachEmail } from './outreach.js';
import type { LlmClient } from './llm.js';
import type { Resolver } from './net-guard.js';
import { NETWORK_LABEL, PROFILE_FILE, PROFILE_FILE_MAX_BYTES, readProfileFile, type ProfileFile, type ProfilePage } from './profiles.js';

export interface RunInput {
  url: string;
  recipient: string | undefined;
  offer: string | undefined;
  senderName?: string | undefined;
  senderCompany?: string | undefined;
  /** The recipient's LinkedIn "Save to PDF" resume. */
  linkedin?: ProfileFile | undefined;
  /** A Markdown export of the recipient's X profile, made with Grok. */
  x?: ProfileFile | undefined;
}

export type Stage = 'fetch' | 'research' | 'verify' | 'draft' | 'done';

export interface ProgressEvent {
  stage: Stage;
  message: string;
}

export interface IrisResult {
  schemaVersion: 1;
  generatedAt: string;
  input: { url: string; recipient: string | null; offer: string; senderName: string; senderCompany: string; linkedin: string | null; x: string | null };
  company: CompanyProfile;
  signals: Signal[];
  hypotheses: Hypothesis[];
  emails: OutreachEmail[];
  sources: Array<{ url: string; title: string }>;
  dropped: DroppedClaim[];
  warnings: string[];
  stats: {
    provider: string;
    model: string;
    pagesRead: number;
    signalsProposed: number;
    signalsVerified: number;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
  };
}

export interface RunDeps {
  config: IrisConfig;
  llm: LlmClient;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
  resolver?: Resolver | undefined;
}

/** Optional single-line text: whitespace collapsed so it cannot add lines to the prompt. */
const oneLine = (max: number, message: string) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max, message))
    .optional()
    .transform((value) => value || undefined);

/** An uploaded profile file: its name and base64 bytes. Decoded and size-checked here. */
const profileFile = (network: 'linkedin' | 'x') =>
  z
    .object({
      name: z.string().max(255).default(''),
      data: z.string().max(Math.ceil(PROFILE_FILE_MAX_BYTES / 3) * 4 + 4, `The ${PROFILE_FILE[network]} must be 2 MB or smaller.`),
    })
    .optional()
    .transform((file): ProfileFile | undefined =>
      file && file.data ? { name: file.name, bytes: new Uint8Array(Buffer.from(file.data, 'base64')) } : undefined,
    );

const RunInputSchema = z.object({
  url: z
    .string({ error: 'Enter a company website.' })
    .trim()
    .min(1, 'Enter a company website.')
    .max(LIMITS.urlChars, 'That URL is too long.'),
  recipient: z
    .string()
    .trim()
    .max(LIMITS.recipientChars, `Recipient must be ${LIMITS.recipientChars} characters or fewer.`)
    .optional()
    .transform((value) => value || undefined),
  offer: z
    .string()
    .trim()
    .max(LIMITS.offerChars, `Your offer must be ${LIMITS.offerChars} characters or fewer.`)
    .optional()
    .transform((value) => value || undefined),
  senderName: oneLine(LIMITS.senderNameChars, `Your name must be ${LIMITS.senderNameChars} characters or fewer.`),
  senderCompany: oneLine(LIMITS.senderCompanyChars, `Your company must be ${LIMITS.senderCompanyChars} characters or fewer.`),
  linkedin: profileFile('linkedin'),
  x: profileFile('x'),
});

/** Validates untrusted input (CLI args or HTTP body) and normalises the URL. */
export function parseRunInput(raw: unknown): RunInput {
  const parsed = RunInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IrisError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input.');
  }
  let url = parsed.data.url;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  let normalized: URL;
  try {
    normalized = new URL(url);
  } catch {
    throw new IrisError('INVALID_INPUT', 'That does not look like a website address.');
  }
  if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
    throw new IrisError('INVALID_INPUT', 'Only http:// and https:// websites are supported.');
  }
  normalized.hash = '';
  const { recipient, offer, senderName, senderCompany, linkedin, x } = parsed.data;
  return { url: normalized.toString(), recipient, offer, senderName, senderCompany, linkedin, x };
}

/** Fetch → research → verify → draft. One run makes two LLM calls (plus at most one repair each). */
export async function runIris(input: RunInput, deps: RunDeps): Promise<IrisResult> {
  const { config, llm } = deps;
  const startedAt = Date.now();
  const emit = (stage: Stage, message: string) => deps.onProgress?.({ stage, message });
  const deadline = AbortSignal.timeout(config.runTimeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  const sender = {
    name: input.senderName ?? config.sender.name,
    company: input.senderCompany ?? config.sender.company,
    offer: input.offer ?? config.sender.offer,
  };

  try {
    const host = new URL(input.url).hostname;
    emit('fetch', `Reading ${host}`);
    const fetchOptions = { ...config.fetch, signal, resolver: deps.resolver };
    const wanted = (['linkedin', 'x'] as const).filter((network) => input[network]);
    if (wanted.length) emit('fetch', `Reading the recipient's ${wanted.map((n) => PROFILE_FILE[n]).join(' and ')}`);
    // A bad profile file fails the run with a clear message rather than silently dropping it.
    const [crawl, ...profiles] = await Promise.all([
      crawlSite(input.url, fetchOptions),
      ...wanted.map((network): Promise<ProfilePage> => readProfileFile(network, input[network]!)),
    ]);
    signal.throwIfAborted();
    const profileWarnings: string[] = [];
    emit(
      'fetch',
      `Read ${crawl.pages.length} page${crawl.pages.length === 1 ? '' : 's'} (${crawl.totalChars.toLocaleString('en-US')} characters)` +
        (profiles.length ? ` and ${profiles.map((p) => NETWORK_LABEL[p.network]).join(' + ')}` : ''),
    );

    emit('research', `Extracting facts with ${llm.model}`);
    const research = await researchCompany(llm, crawl.pages, sender, signal, profiles);
    const { brief } = research;
    emit(
      'verify',
      `Verified ${brief.signals.length} of ${brief.proposedSignals} claims against the source text` +
        (brief.dropped.length ? ` (dropped ${brief.dropped.length})` : ''),
    );

    emit('draft', `Drafting outreach to ${brief.company.name}`);
    const outreach = await draftOutreach(llm, brief, sender, parseRecipient(input.recipient), signal);

    const durationMs = Date.now() - startedAt;
    emit('done', `Done in ${(durationMs / 1000).toFixed(1)}s`);

    for (const page of profiles) {
      if (!brief.signals.some((s) => s.category === 'person' && s.sourceUrl === page.url)) {
        profileWarnings.push(`No usable professional details were found in the ${PROFILE_FILE[page.network]}, so the drafts do not reference it.`);
      }
    }
    const warnings = [...profileWarnings, ...outreach.warnings];
    if (crawl.skipped.length) warnings.push(`${crawl.skipped.length} supporting page(s) could not be read.`);

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      input: { url: crawl.finalUrl, recipient: input.recipient ?? null, offer: sender.offer, senderName: sender.name, senderCompany: sender.company, linkedin: input.linkedin?.name ?? null, x: input.x?.name ?? null },
      company: brief.company,
      signals: brief.signals,
      hypotheses: brief.hypotheses,
      emails: outreach.emails,
      sources: [...crawl.pages, ...profiles].map((page) => ({ url: page.url, title: page.title })),
      dropped: brief.dropped,
      warnings,
      stats: {
        provider: llm.provider,
        model: llm.model,
        pagesRead: crawl.pages.length,
        signalsProposed: brief.proposedSignals,
        signalsVerified: brief.signals.length,
        durationMs,
        promptTokens: research.usage.promptTokens + outreach.usage.promptTokens,
        completionTokens: research.usage.completionTokens + outreach.usage.completionTokens,
      },
    };
  } catch (error) {
    if (deadline.aborted && !deps.signal?.aborted) {
      throw new IrisError('LLM_TIMEOUT', `The run took longer than ${Math.round(config.runTimeoutMs / 1000)} seconds and was stopped.`);
    }
    throw toIrisError(error);
  }
}
