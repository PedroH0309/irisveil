import { IrisError } from './errors.js';
import { extractDocument } from './extract.js';
import { fetchHtml, type FetchOptions, type SourcePage } from './site.js';

/**
 * The recipient's public LinkedIn and X profiles, read like any other source page so that
 * facts about the person go through the same verbatim-quote check as facts about the company.
 * Both networks often hide profiles behind a sign-in wall; a failed read is a warning, not an error.
 */

export type ProfileNetwork = 'linkedin' | 'x';

export const NETWORK_LABEL: Record<ProfileNetwork, string> = { linkedin: 'LinkedIn', x: 'X' };

const PROFILE_TEXT_CHARS = 4_000;

/** Accepts a full profile URL, or an @handle for X. Returns a canonical https URL. */
export function normalizeProfileUrl(network: ProfileNetwork, raw: string): string {
  const value = raw.trim();
  const handle = /^@?([A-Za-z0-9_]{1,15})$/.exec(value);
  if (network === 'x' && handle) return `https://x.com/${handle[1]}`;

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new IrisError('INVALID_INPUT', `That does not look like a ${NETWORK_LABEL[network]} profile URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const ok =
    network === 'linkedin'
      ? (host === 'linkedin.com' || host.endsWith('.linkedin.com')) && /^\/in\/[^/]+/.test(url.pathname)
      : (host === 'x.com' || host === 'twitter.com') && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname);
  if (!ok) {
    const example = network === 'linkedin' ? 'https://www.linkedin.com/in/priya-rao' : 'https://x.com/priyarao or @priyarao';
    throw new IrisError('INVALID_INPUT', `Enter a ${NETWORK_LABEL[network]} profile, for example ${example}.`);
  }
  url.protocol = 'https:';
  url.hostname = network === 'x' ? 'x.com' : 'www.linkedin.com';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export interface ProfilePage extends SourcePage {
  network: ProfileNetwork;
}

/** Reads one public profile page. Throws when the page is unreadable or behind a sign-in wall. */
export async function fetchProfile(network: ProfileNetwork, url: string, options: FetchOptions): Promise<ProfilePage> {
  const response = await fetchHtml(url, options);
  if (response.status >= 400) throw new IrisError('FETCH_FAILED', `HTTP ${response.status}`);
  const doc = extractDocument(response.html);
  const text = doc.text.slice(0, PROFILE_TEXT_CHARS);
  if (text.length + doc.description.length < 80 || /\b(sign in|log in|join now)\b.{0,40}\b(to (see|view|continue))/i.test(doc.title + doc.text.slice(0, 400))) {
    throw new IrisError('SITE_TOO_THIN', 'profile is behind a sign-in wall or has no readable text');
  }
  return { network, url: response.url, title: doc.title.slice(0, 200), description: doc.description.slice(0, 400), text };
}
