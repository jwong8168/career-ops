# Applications Tracker — TEST FIXTURE
#
# Committed, deterministic fixture used by test-all.mjs to exercise
# verify-pipeline.mjs independently of the user's gitignored
# data/applications.md. It must satisfy ALL 7 checks in verify-pipeline.mjs
# (canonical statuses, no dupes, valid report links, score format X.X/5|N/A|DUP,
# >=9 columns, no bold in scores). Do NOT point real personal data here.

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-01-02 | Acme Corp | Director of Program Management | 4.2/5 | Evaluated | ✅ | — | Numeric score, canonical evaluated. |
| 2 | 2026-01-03 | Globex | Senior Product Manager | 3.0/5 | Applied | ✅ | — | Applied status fixture row. |
| 3 | 2026-01-04 | Initech | Staff Program Manager | N/A | Applied | — | — | N/A score (not CareerOps-evaluated). |
| 4 | 2026-01-05 | Umbrella | Product Operations Lead | DUP | skip | — | — | DUP score, skip status. |
| 5 | 2026-01-06 | Soylent | AD, Portfolio Strategy | 2.5/5 | Rejected | ✅ | — | Rejected status fixture row. |
