#!/usr/bin/env node
/**
 * gemini-eval.mjs — Gemini-powered Job Offer Evaluator for career-ops
 *
 * A free-tier alternative to the Claude-based pipeline.
 * Reads evaluation logic from modes/oferta.md + modes/_shared.md,
 * reads the user's resume from cv.md, and evaluates a Job Description
 * passed as a command-line argument.
 *
 * Usage:
 *   node gemini-eval.mjs "Paste full JD text here"
 *   node gemini-eval.mjs --file ./jds/my-job.txt
 *
 * Requires:
 *   GEMINI_API_KEY in .env (or environment variable)
 *
 * Free-tier model: gemini-2.5-flash (generous quota, no billing required)
 *
 * Model deprecation reference (per Google AI for Developers, May 2026):
 *   - gemini-2.0-flash       deprecated 2026-03-31  (do not use)
 *   - gemini-2.0-flash-lite  deprecated 2026-03-31
 *   - gemini-2.5-flash       deprecated 2026-06-17  (current default)
 *   - gemini-2.5-flash-lite  deprecated 2026-07-22
 * Stable Gemini models follow a 12-month lifecycle from their release date.
 * Source: https://ai.google.dev/gemini-api/docs/models
 *
 * When the current default approaches its deprecation date, bump
 * `modelName` below and the `--model` examples accordingly.
 *
 * ---------------------------------------------------------------------------
 * STRUCTURE
 * ---------------------------------------------------------------------------
 * The pure helpers below (prompt assembly, score-summary extraction, report
 * formatting, report numbering, company slugification) are exported so they
 * can be unit-tested without a live Gemini call. All CLI side-effects (argv
 * parsing, env validation, file I/O, the model call) live behind the
 * `import.meta.url` guard at the bottom, so importing this module is safe.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  // Primary evaluation logic lives in these two mode files
  shared:      join(ROOT, 'modes', '_shared.md'),
  oferta:      join(ROOT, 'modes', 'oferta.md'),
  // Canonical skill path referenced in Issue #344
  evaluate:    join(ROOT, '.claude', 'skills', 'career-ops', 'SKILL.md'),
  cv:          join(ROOT, 'cv.md'),
  profile:     join(ROOT, 'modes', '_profile.md'),
  profileYml:  join(ROOT, 'config', 'profile.yml'),
  reports:     join(ROOT, 'reports'),
  tracker:     join(ROOT, 'data', 'applications.md'),
};

// ===========================================================================
// PURE HELPERS (exported for unit testing — no I/O, no process.exit, no API)
// ===========================================================================

/**
 * Assemble the Gemini system prompt from the loaded context files.
 * Mirrors the Claude skill router logic. Pure: same inputs → same string.
 */
export function buildSystemPrompt({
  sharedContext = '',
  ofertaLogic = '',
  cvContent = '',
  profileYml = '',
  profileContent = '',
} = {}) {
  return `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
CANDIDATE PROFILE & TARGETS (config/profile.yml)
═══════════════════════════════════════════════════════
${profileYml}

═══════════════════════════════════════════════════════
USER ARCHETYPES & NARRATIVE (_profile.md)
═══════════════════════════════════════════════════════
${profileContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;
}

/**
 * Extract the machine-readable score summary from a Gemini evaluation.
 * Returns the parsed fields, falling back to the same defaults the CLI uses
 * when the summary block is missing or a field is absent.
 *
 * @param {string} evaluationText - raw model output (the "mocked" boundary).
 * @returns {{company,role,score,archetype,legitimacy}}
 */
export function parseScoreSummary(evaluationText) {
  const defaults = {
    company:    'unknown',
    role:       'unknown',
    score:      '?',
    archetype:  'unknown',
    legitimacy: 'unknown',
  };

  if (typeof evaluationText !== 'string') return { ...defaults };

  const summaryMatch = evaluationText.match(
    /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
  );
  if (!summaryMatch) return { ...defaults };

  const block = summaryMatch[1];
  const extract = (key) => {
    const prefix = `${key}:`;
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
      }
    }
    return 'unknown';
  };

  return {
    company:    extract('COMPANY'),
    role:       extract('ROLE'),
    score:      extract('SCORE'),
    archetype:  extract('ARCHETYPE'),
    legitimacy: extract('LEGITIMACY'),
  };
}

/**
 * Slugify a company name for use in a report filename.
 * Lowercases, collapses non-alphanumerics to single hyphens, trims edges.
 */
export function slugifyCompany(company) {
  return String(company)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Compute the next zero-padded 3-digit report number from existing filenames.
 * Pure version of the CLI helper: the CLI passes `readdirSync(PATHS.reports)`.
 * Ignores filenames that don't start with a 3-digit prefix.
 */
export function computeNextReportNumber(filenames = []) {
  const nums = (Array.isArray(filenames) ? filenames : [])
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3), 10))
    .filter(n => !isNaN(n));
  if (nums.length === 0) return '001';
  return String(Math.max(...nums) + 1).padStart(3, '0');
}

/**
 * Build the saved report markdown body. Carries the `${score}/5` formatting.
 * The summary block is stripped from the appended evaluation text.
 */
export function buildReportContent({
  company,
  role,
  today,
  archetype,
  score,
  legitimacy,
  modelName,
  evaluationText = '',
}) {
  return `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;
}

/**
 * Format the one-line console summary footer.
 */
export function formatScoreLine({ score, archetype, legitimacy }) {
  return `  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`;
}

// ===========================================================================
// CLI (guarded — only runs when executed directly, never on import)
// ===========================================================================

const HELP_TEXT = `
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Gemini Evaluator (free-tier)             ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Google Gemini instead of Claude.

  USAGE
    node gemini-eval.mjs "<JD text>"
    node gemini-eval.mjs --file ./jds/my-job.txt
    node gemini-eval.mjs --model gemini-2.5-flash "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Gemini model to use (default: gemini-2.5-flash)
    --no-save        Do not save report to reports/ directory
    --help           Show this help

  SETUP
    1. Get a free API key at https://aistudio.google.com/apikey
    2. Add GEMINI_API_KEY=<your-key> to .env
    3. Run: npm install   (installs @google/generative-ai + dotenv)

  EXAMPLES
    node gemini-eval.mjs "We are looking for a Senior AI Engineer..."
    node gemini-eval.mjs --file ./jds/openai-swe.txt
`;

function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

async function main() {
  // Load .env before anything else
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv is optional — fall back to process.env if not installed
  }

  // -------------------------------------------------------------------------
  // CLI argument parsing
  // -------------------------------------------------------------------------
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  let jdText = '';
  let modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  let saveReport = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      const filePath = args[++i];
      if (!existsSync(filePath)) {
        console.error(`❌  File not found: ${filePath}`);
        process.exit(1);
      }
      jdText = readFileSync(filePath, 'utf-8').trim();
    } else if (args[i] === '--model' && args[i + 1]) {
      modelName = args[++i];
    } else if (args[i] === '--no-save') {
      saveReport = false;
    } else if (!args[i].startsWith('--')) {
      jdText += (jdText ? '\n' : '') + args[i];
    }
  }

  if (!jdText) {
    console.error('❌  No Job Description provided. Run with --help for usage.');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Validate environment
  // -------------------------------------------------------------------------
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(`
❌  GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
   3. Or export it:     export GEMINI_API_KEY=your_key_here
`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Load context files
  // -------------------------------------------------------------------------
  console.log('\n📂  Loading context files...');

  const sharedContext  = readFile(PATHS.shared,      'modes/_shared.md');
  const ofertaLogic    = readFile(PATHS.oferta,      'modes/oferta.md');
  const cvContent      = readFile(PATHS.cv,          'cv.md');
  const profileContent = readFile(PATHS.profile,     'modes/_profile.md');
  const profileYml     = readFile(PATHS.profileYml,  'config/profile.yml');

  // -------------------------------------------------------------------------
  // Build the system prompt (mirrors the Claude skill router logic)
  // -------------------------------------------------------------------------
  const systemPrompt = buildSystemPrompt({
    sharedContext,
    ofertaLogic,
    cvContent,
    profileYml,
    profileContent,
  });

  // -------------------------------------------------------------------------
  // Call Gemini API
  // -------------------------------------------------------------------------
  console.log(`🤖  Calling Gemini (${modelName})... this may take 30-60 seconds.\n`);

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.4,      // deterministic enough for structured evaluation
      maxOutputTokens: 8192, // full 7-block evaluation
    },
  });

  let evaluationText;
  try {
    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `\n\nJOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
    ]);
    evaluationText = result.response.text();
  } catch (err) {
    const sanitizedMsg = (err.message || '').split(apiKey).join('[REDACTED]');
    console.error('❌  Gemini API error:', sanitizedMsg);
    if (sanitizedMsg.includes('API_KEY')) {
      console.error('    Check your GEMINI_API_KEY in .env');
    } else if (sanitizedMsg.includes('quota') || sanitizedMsg.includes('rate')) {
      console.error('    You may have hit the free-tier rate limit. Wait 60s and retry.');
    }
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Display evaluation
  // -------------------------------------------------------------------------
  console.log('\n' + '═'.repeat(66));
  console.log('  CAREER-OPS EVALUATION — powered by Google Gemini');
  console.log('═'.repeat(66) + '\n');
  console.log(evaluationText);

  // -------------------------------------------------------------------------
  // Parse score summary
  // -------------------------------------------------------------------------
  const { company, role, score, archetype, legitimacy } = parseScoreSummary(evaluationText);

  // -------------------------------------------------------------------------
  // Save report
  // -------------------------------------------------------------------------
  if (saveReport) {
    try {
      if (!existsSync(PATHS.reports)) {
        mkdirSync(PATHS.reports, { recursive: true });
      }

      const num         = computeNextReportNumber(readdirSync(PATHS.reports));
      const today       = new Date().toISOString().split('T')[0];
      const companySlug = slugifyCompany(company);
      const filename    = `${num}-${companySlug}-${today}.md`;
      const reportPath  = join(PATHS.reports, filename);

      const reportContent = buildReportContent({
        company, role, today, archetype, score, legitimacy, modelName, evaluationText,
      });

      writeFileSync(reportPath, reportContent, 'utf-8');
      console.log(`\n✅  Report saved: reports/${filename}`);

      // Append tracker entry reminder
      console.log(`\n📊  Tracker entry (add to data/applications.md):`);
      console.log(`    | ${num} | ${today} | ${company} | ${role} | ${score} | Evaluada | ❌ | [${num}](reports/${filename}) |`);
    } catch (err) {
      console.warn(`⚠️   Could not save report: ${err.message}`);
    }
  }

  console.log('\n' + '─'.repeat(66));
  console.log(formatScoreLine({ score, archetype, legitimacy }));
  console.log('─'.repeat(66) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
