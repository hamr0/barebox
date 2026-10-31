#!/bin/bash
# A/B the 20-agent worst case: swap off vs swap on with 10 secrets, alternating, 3 pairs. Prints load before each run.
cd "$(dirname "$0")"
for i in 1 2 3; do
  for v in off on; do
    echo "--- run $i swap=$v load=$(cut -d' ' -f1-3 /proc/loadavg)"
    if [ $v = on ]; then POC_SWAP=10 node bench-agents.mjs 2>&1 | grep -E "^\| 20 |Drift|FINDING|PASS|FAIL|SKIP"
    else node bench-agents.mjs 2>&1 | grep -E "^\| 20 |Drift|FINDING|PASS|FAIL|SKIP"; fi
  done
done
