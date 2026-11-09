import { extractText, getDocumentProxy } from 'unpdf';
import { IrisVeilError } from './errors.js';
import type { SourcePage } from './site.js';

/**
 * The recipient's profiles, supplied as files because LinkedIn and X refuse automated reads:
 * the "Save to PDF" resume every LinkedIn profile offers, and a Markdown export of an X profile
 * produced with Grok. Their text is researched and quote-checked like any page of the company site.
 */

export type ProfileNetwork = 'linkedin' | 'x';

export const NETWORK_LABEL: Record<ProfileNetwork, string> = { linkedin: 'LinkedIn', x: 'X' };

/** What each file is, for error messages. */
export const PROFILE_FILE: Record<ProfileNetwork, string> = { linkedin: 'LinkedIn PDF', x: 'X Markdown file' };

/** Profile facts cite these URLs, so drafts and sources can tell which network a fact came from. */
const SOURCE_URL: Record<ProfileNetwork, string> = { linkedin: 'https://www.linkedin.com/', x: 'https://x.com/' };

export const PROFILE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_TEXT_CHARS = 8_000;

export interface ProfileFile {
  /** Original file name, shown back to the user. */
  name: string;
  bytes: Uint8Array;
}

export interface ProfilePage extends SourcePage {
  network: ProfileNetwork;
  fileName: string;
}

const isPdf = (bytes: Uint8Array) => bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';

async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true });
    const { text } = await extractText(pdf, { mergePages: true });
    await pdf.destroy();
    return text;
  } catch {
    throw new IrisVeilError('INVALID_INPUT', 'That LinkedIn PDF could not be read. Download it again with More → Save to PDF on the profile.');
  }
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PROFILE_TEXT_CHARS);
}

/** Reads one profile file into a source page. Throws INVALID_INPUT for the wrong kind of file. */
export async function readProfileFile(network: ProfileNetwork, file: ProfileFile): Promise<ProfilePage> {
  const { bytes } = file;
  if (bytes.length === 0) throw new IrisVeilError('INVALID_INPUT', `The ${PROFILE_FILE[network]} is empty.`);
  if (bytes.length > PROFILE_FILE_MAX_BYTES) throw new IrisVeilError('INVALID_INPUT', `The ${PROFILE_FILE[network]} must be 2 MB or smaller.`);

  let text: string;
  if (network === 'linkedin') {
    if (!isPdf(bytes)) throw new IrisVeilError('INVALID_INPUT', 'The LinkedIn file must be the PDF from More → Save to PDF on the profile.');
    text = await pdfText(bytes);
  } else {
    if (isPdf(bytes) || bytes.includes(0)) throw new IrisVeilError('INVALID_INPUT', 'The X file must be the Markdown (.md) export from Grok.');
    text = new TextDecoder('utf-8').decode(bytes);
  }

  const clean = tidy(text);
  if (clean.length < 40) throw new IrisVeilError('INVALID_INPUT', `The ${PROFILE_FILE[network]} has almost no readable text.`);
  const name = file.name.replace(/[^\w .()-]/g, '').slice(0, 120) || `${network}-profile`;
  return {
    network,
    fileName: name,
    url: SOURCE_URL[network],
    title: `${NETWORK_LABEL[network]} profile (${name})`,
    description: '',
    text: clean,
  };
}
