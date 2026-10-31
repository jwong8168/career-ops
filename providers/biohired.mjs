// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// BioHired provider — scrapes the pharma/biotech aggregator at biohired.com.
// No REST API; parses server-rendered HTML from the search endpoint.
// Search filters (seniority, department, location_type, date_posted) are
// passed via the `biohired_filters` object in portals.yml.
//
// Usage in portals.yml:
//   - name: BioHired (Pharma Aggregator)
//     careers_url: "https://biohired.com/"
//     api: "biohired"
//     enabled: true
//     biohired_filters:
//       seniority: "director"
//       english_only: true
//       date_posted: "7d"

const BASE_URL = 'https://biohired.com/';
const MAX_PAGES = 10;
const JOBS_PER_PAGE = 26;

/** @type {Provider} */
export default {
  id: 'biohired',

  detect(entry) {
    if (entry.api === 'biohired') return { url: BASE_URL };
    if (typeof entry.careers_url === 'string' && entry.careers_url.includes('biohired.com')) {
      return { url: BASE_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const filters = entry.biohired_filters || {};
    const allJobs = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = buildSearchUrl(filters, page);
      const html = await ctx.fetchText(url, {
        headers: {
          'accept': 'text/html',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        },
      });

      const jobs = parseSearchResults(html);
      if (jobs.length === 0) break;
      allJobs.push(...jobs);
      if (jobs.length < JOBS_PER_PAGE) break;
    }

    return allJobs;
  },
};

function buildSearchUrl(filters, page) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('sort', 'newest');

  if (filters.search) params.set('search', filters.search);
  if (filters.location) params.set('location', filters.location);
  if (filters.seniority) params.set('seniority', filters.seniority);
  if (filters.department) params.set('department', filters.department);
  if (filters.location_type) params.set('location_type', filters.location_type);
  if (filters.date_posted) params.set('date_posted', filters.date_posted);
  if (filters.english_only) params.set('english_only', 'on');
  if (filters.has_salary) params.set('has_salary', 'on');
  if (filters.hide_ghost) params.set('hide_ghost', 'on');
  if (filters.company_id) params.set('company_id', String(filters.company_id));

  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Parse job cards from BioHired search results HTML.
 *
 * Each job card has:
 *   <div class="job-card">
 *     <h3 class="job-title"><a href="/jobs/{ID}">{TITLE}</a></h3>
 *     <span class="company"><a href="/companies/{slug}">{NAME}</a></span>
 *     <span class="location">{LOCATION}</span>
 *     <span class="department">{DEPT}</span>
 *     <a href="{APPLY_URL}" target="_blank" class="btn btn-small btn-primary">
 *
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseSearchResults(html) {
  const jobs = [];

  // Split into job cards
  const cards = html.split(/class="job-card/).slice(1);

  for (const card of cards) {
    const title = extractBetween(card, 'class="job-title">', '</h3>');
    const titleText = title ? decodeHtmlEntities(stripTags(title).trim()) : '';
    if (!titleText) continue;

    // Job URL from title link
    const jobHref = extractAttr(card, 'job-title', 'href');
    const jobUrl = jobHref ? `https://biohired.com${jobHref}` : '';

    // Company name from company span
    const companyBlock = extractBetween(card, 'class="company">', '</span>');
    const companyText = companyBlock ? decodeHtmlEntities(stripTags(companyBlock).trim()) : '';

    // Location
    const locationBlock = extractBetween(card, 'class="location">', '</span>');
    const locationText = locationBlock ? decodeHtmlEntities(stripTags(locationBlock).trim()) : '';

    // Apply URL (the actual ATS link)
    const applyMatch = card.match(/href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*class="btn btn-small btn-primary"/);
    const applyUrl = applyMatch ? applyMatch[1] : '';

    jobs.push({
      title: titleText,
      url: applyUrl || jobUrl,
      company: companyText,
      location: locationText,
    });
  }

  return jobs;
}

function extractBetween(str, startMarker, endMarker) {
  const startIdx = str.indexOf(startMarker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = str.indexOf(endMarker, contentStart);
  if (endIdx === -1) return null;
  return str.slice(contentStart, endIdx);
}

function extractAttr(card, className, attr) {
  const classIdx = card.indexOf(`class="${className}"`);
  if (classIdx === -1) return null;
  // Look for <a href="..."> within the next ~200 chars
  const region = card.slice(classIdx, classIdx + 300);
  const match = region.match(new RegExp(`<a\\s+${attr}="([^"]+)"`));
  return match ? match[1] : null;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
