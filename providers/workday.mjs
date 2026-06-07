// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public CXS job-posting API (POST-based).
// Workday requires three non-guessable URL components (tenant, datacenter,
// site ID), so auto-detection is limited to entries with an explicit `api`
// field prefixed with "workday:". The CXS API enforces a max page size of
// 20 and may block requests without browser-like headers.

const PAGE_SIZE = 20;
const MAX_PAGES = 50;

const ALLOWED_WORKDAY_HOST_RE = /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/;

function assertWorkdayUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workday: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workday: URL must use HTTPS: ${url}`);
  if (!ALLOWED_WORKDAY_HOST_RE.test(parsed.hostname)) {
    throw new Error(`workday: untrusted hostname "${parsed.hostname}" — must match *.wd{N}.myworkdayjobs.com`);
  }
  if (!parsed.pathname.includes('/wday/cxs/')) {
    throw new Error(`workday: URL must contain /wday/cxs/ path: ${url}`);
  }
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api && typeof entry.api === 'string' && entry.api.startsWith('workday:')) {
    return entry.api.slice('workday:'.length);
  }
  return null;
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) return null;
    try {
      assertWorkdayUrl(apiUrl);
      return { url: apiUrl };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`workday: no api field for ${entry.name} — set api: "workday:<cxs_url>"`);
    assertWorkdayUrl(apiUrl);

    const allPostings = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await ctx.fetchJson(apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        },
        body: JSON.stringify({ limit: PAGE_SIZE, offset, searchText: '' }),
      });
      const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      allPostings.push(...postings);
      if (postings.length < PAGE_SIZE || allPostings.length >= (json?.total || 0)) break;
      offset += PAGE_SIZE;
    }

    return parseWorkdayPostings(allPostings, entry);
  },
};

/**
 * Parse Workday job postings into normalized Job objects.
 * @param {any[]} postings
 * @param {{ name: string, careers_url?: string }} entry
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseWorkdayPostings(postings, entry) {
  const baseUrl = entry.careers_url || '';
  let baseHost = '';
  try {
    const parsed = new URL(baseUrl);
    baseHost = `${parsed.protocol}//${parsed.host}`;
  } catch { /* ignore */ }

  return postings
    .filter(j => j.title && j.externalPath)
    .map(j => {
      const url = baseHost
        ? `${baseHost}${j.externalPath}`
        : `https://myworkdayjobs.com${j.externalPath}`;
      return {
        title: j.title,
        url,
        company: entry.name,
        location: j.locationsText || '',
      };
    });
}
