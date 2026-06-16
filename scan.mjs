#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, Lever, SmartRecruiters, Workable,
 * Workday, and BioHired (pharma aggregator) directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON/HTML.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import localParserProvider from './providers/local-parser.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  // SmartRecruiters
  const srMatch = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)/);
  if (srMatch) {
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${srMatch[1]}/postings?limit=100`,
    };
  }

  // Workable
  const workableMatch = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (workableMatch) {
    return {
      type: 'workable',
      url: `https://apply.workable.com/api/v1/widget/accounts/${workableMatch[1]}`,
    };
  }

  // Workday — requires explicit api field with format "workday:{cxs_base_url}"
  if (company.api && company.api.startsWith('workday:')) {
    return {
      type: 'workday',
      url: company.api.slice('workday:'.length),
    };
  }

  // BioHired — pharma/biotech aggregator (HTML scraper, not JSON API)
  if (company.api === 'biohired') {
    return { type: 'biohired', url: 'https://biohired.com/' };
  }

  return null;
}

// ── Provider resolution ─────────────────────────────────────────────
// A company is scanned either by a local executable parser (configured via
// `parser.command` + `parser.script` in portals.yml) or by a built-in ATS
// API (detectApi). The local parser runs first; if it fails at fetch time the
// caller re-resolves with skipIds:['local-parser'] to fall back to the ATS API.
const providers = new Map([[localParserProvider.id, localParserProvider]]);

function resolveProvider(company, providers, { skipIds = [] } = {}) {
  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      if (localParser.detect?.(company)) {
        return { kind: 'provider', provider: localParser };
      }
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${company.name}" — ${err.message}`);
    }
  }
  const api = detectApi(company);
  if (api) return { kind: 'api', api };
  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

function parseSmartRecruiters(json, companyName) {
  const jobs = json.content || [];
  return jobs.map(j => ({
    title: j.name || '',
    url: j.ref || j.company?.identifier
      ? `https://jobs.smartrecruiters.com/${json.company?.identifier || companyName}/${j.id}`
      : '',
    company: companyName,
    location: j.location?.city
      ? `${j.location.city}${j.location.region ? ', ' + j.location.region : ''}`
      : (j.location?.remote ? 'Remote' : ''),
  }));
}

function parseWorkable(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.url || j.shortlink || '',
    company: companyName,
    location: j.city ? `${j.city}${j.state ? ', ' + j.state : ''}` : (j.telecommuting ? 'Remote' : ''),
  }));
}

function parseWorkday(json, companyName) {
  const jobs = json.jobPostings || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.externalPath ? `https://myworkdayjobs.com${j.externalPath}` : '',
    company: companyName,
    location: j.locationsText || '',
  }));
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function parseBiohired(html, _companyName) {
  const jobs = [];
  const cards = html.split(/class="job-card/).slice(1);
  for (const card of cards) {
    const titleMatch = card.match(/class="job-title">\s*<a href="([^"]+)">([^<]+)<\/a>/);
    if (!titleMatch) continue;
    const jobPath = titleMatch[1];
    const title = decodeHtmlEntities(titleMatch[2].trim());
    const companyMatch = card.match(/class="company">[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    const company = companyMatch ? decodeHtmlEntities(companyMatch[1].trim()) : '';
    const locationMatch = card.match(/class="location">([^<]+)<\/span>/);
    const location = locationMatch ? decodeHtmlEntities(locationMatch[1].trim()) : '';
    const applyMatch = card.match(/href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*class="btn btn-small btn-primary"/);
    const url = applyMatch ? applyMatch[1] : `https://biohired.com${jobPath}`;
    jobs.push({ title, url, company, location });
  }
  return jobs;
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  ashby: parseAshby,
  lever: parseLever,
  smartrecruiters: parseSmartRecruiters,
  workable: parseWorkable,
  workday: parseWorkday,
  biohired: parseBiohired,
};

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkday(url) {
  const PAGE_SIZE = 20;
  const MAX_PAGES = 50;
  const hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
  };
  let allPostings = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJson(url, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ limit: PAGE_SIZE, offset, searchText: '' }),
    });
    const postings = json.jobPostings || [];
    allPostings = allPostings.concat(postings);
    if (postings.length < PAGE_SIZE || allPostings.length >= (json.total || 0)) break;
    offset += PAGE_SIZE;
  }
  return { jobPostings: allPostings, total: allPostings.length };
}

async function fetchBiohired(company) {
  const MAX_PAGES = 10;
  const JOBS_PER_PAGE = 26;
  const filters = company.biohired_filters || {};
  const hdrs = {
    'Accept': 'text/html',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
  };
  let allHtml = '';
  let totalJobs = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
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
    const url = `https://biohired.com/?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let html;
    try {
      const res = await fetch(url, { headers: hdrs, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const cardCount = (html.match(/class="job-card/g) || []).length;
    allHtml += html;
    totalJobs += cardCount;
    if (cardCount < JOBS_PER_PAGE) break;
  }
  return allHtml;
}

// Dispatch a fetch by detected ATS type.
async function fetchData(type, url, company) {
  if (type === 'biohired') return fetchBiohired(company);
  if (type === 'workday') return fetchWorkday(url);
  return fetchJson(url);
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics (case-insensitive substring, in this order):
//   - Empty / whitespace-only / non-string location → pass (don't penalize
//     missing or malformed provider data)
//   - `always_allow` matches → pass (takes precedence over `block` — lets a
//     multi-location string like "Remote, Belgium or France" through because
//     the home region is an option, even though "france" is blocked)
//   - `block` matches → reject
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  // 2. Resolve a provider (local parser or ATS API) for each enabled company.
  //    Guard company.name before any string operation so malformed portals.yml
  //    entries are skipped with a clear warning rather than crashing the scan.
  const targets = [];
  let skippedCount = 0;
  for (const company of companies) {
    if (!company || typeof company !== 'object') continue;
    if (company.enabled === false) continue;
    if (typeof company.name !== 'string' || !company.name.trim()) {
      console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(company)}`);
      continue;
    }
    if (filterCompany && !company.name.toLowerCase().includes(filterCompany)) continue;
    const resolved = resolveProvider(company, providers);
    if (!resolved) { skippedCount++; continue; }
    targets.push({ ...company, _resolved: resolved });
  }

  console.log(`Scanning ${targets.length} companies via providers (${skippedCount} skipped — no provider matched)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalFilteredLocation = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const resolved = company._resolved;
    try {
      let jobs;
      let sourceName;
      if (resolved.kind === 'provider') {
        // Local parser runs first; on failure, fall back to the ATS API.
        try {
          jobs = await resolved.provider.fetch(company);
          sourceName = resolved.provider.id;
        } catch (parserErr) {
          const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
          if (!fallback || fallback.kind !== 'api') throw parserErr;
          const { type, url } = fallback.api;
          const data = await fetchData(type, url, company);
          jobs = PARSERS[type](data, company.name);
          sourceName = `${type}-api`;
          errors.push({
            company: company.name,
            error: `local parser failed, used API fallback: ${parserErr.message}`,
          });
        }
      } else {
        const { type, url } = resolved.api;
        const data = await fetchData(type, url, company);
        jobs = PARSERS[type](data, company.name);
        sourceName = `${type}-api`;
      }

      if (!Array.isArray(jobs)) throw new Error('fetch() did not return an array');
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: sourceName });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Only run the scan when invoked as a CLI — importing this module (e.g. tests
// importing buildLocationFilter) must not trigger a live scan or write data.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
