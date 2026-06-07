#!/bin/bash
# Daily career-ops portal scan — outputs to scan-latest.txt for morning brief pickup
set -euo pipefail

CAREER_OPS="$HOME/Documents/Software Projects/career-ops"
OUTPUT_FILE="$CAREER_OPS/data/scan-latest.txt"

cd "$CAREER_OPS"

# Run scan and capture output
npm run scan 2>&1 | tee "$OUTPUT_FILE"

# If new offers found, also write a summary for morning brief
if grep -q "New offers added:      0" "$OUTPUT_FILE"; then
  echo "No new offers" > "$CAREER_OPS/data/scan-summary.txt"
else
  # Extract just the new offers section
  sed -n '/^New offers:/,/^$/p' "$OUTPUT_FILE" > "$CAREER_OPS/data/scan-summary.txt"
  echo "" >> "$CAREER_OPS/data/scan-summary.txt"
  grep "New offers added:" "$OUTPUT_FILE" >> "$CAREER_OPS/data/scan-summary.txt"
fi
