// ============================================================================
// SECURITY BOUNDARY
// ----------------------------------------------------------------------------
// This file is the ONLY place in the app that is allowed to make an outbound
// web request. Any URL whose host is not on ALLOWED_HOSTS is refused *before*
// the request is made.
//
// Design rules this enforces:
//   - The local LLM has no network access of its own.
//   - User data (profile, questions) is NEVER passed to safeFetch — only
//     public official URLs are. So nothing about a user ever leaves the device.
//   - Only official Swiss government / university domains can be reached.
// ============================================================================

export const ALLOWED_HOSTS = [
  "sem.admin.ch",
  "admin.ch", // covers *.admin.ch federal offices
  "ch.ch",
  "bern.ch",
  "be.ch",
  "bag.admin.ch",
  "priminfo.admin.ch",
  "bfh.ch",
  // University of Bern: the other host university students can choose.
  "unibe.ch",
  "sbb.ch",
  // Information centre of the federal old-age and disability insurance
  // (AHV/IV), run by the compensation offices and the Federal Social Insurance Office.
  "ahv-iv.ch",
  // Suva: the federal public-law accident insurer (accident insurance under the UVG).
  "suva.ch",
];

export class BlockedUrlError extends Error {
  constructor(url: string) {
    super(`Blocked: "${url}" is not on the official-sources allow-list.`);
    this.name = "BlockedUrlError";
  }
}

/** True only for https URLs whose host is (or is a subdomain of) an allowed host. */
export function isAllowedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false; // no http, no file:, etc.
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * The single gateway for any outbound fetch. Refuses non-allow-listed hosts,
 * and re-checks the final URL after any redirects so a redirect can't smuggle
 * the request off the allow-list.
 */
export type FetchedDocument = {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
};

const MAX_REDIRECTS = 5;

/**
 * Raw fetch through the allow-list. Redirects are followed manually so every
 * hop is checked BEFORE a request is made to it — a redirect can never send us
 * to a host that isn't on the list.
 */
export async function safeFetchRaw(rawUrl: string, timeoutMs = 20_000): Promise<FetchedDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(url)) throw new BlockedUrlError(url);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "HelvetiStart/0.2 (student relocation assistant; official sources only)",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect without location from ${url}`);
        url = new URL(location, url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`Fetch failed with ${res.status} for ${url}`);
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? "",
        finalUrl: url,
      };
    }
    throw new Error(`Too many redirects for ${rawUrl}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Text fetch through the allow-list (HTML pages). */
export async function safeFetch(rawUrl: string, timeoutMs = 20_000): Promise<string> {
  const doc = await safeFetchRaw(rawUrl, timeoutMs);
  return new TextDecoder().decode(doc.bytes);
}
