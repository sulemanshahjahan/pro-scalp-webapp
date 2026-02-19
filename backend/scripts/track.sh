#!/bin/bash
# Run this every few hours to track performance
# Usage: ./track.sh [hours]

HOURS=${1:-6}
DIR="$(dirname "$0")"

node "$DIR/report38h.mjs" 2>&1 | tee -a "$DIR/performance.log"
echo "--- Snapshot taken at $(date) ---" >> "$DIR/performance.log"
echo "" >> "$DIR/performance.log"
