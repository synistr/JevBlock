#!/bin/bash
# Runs xcodebuild with the full log in $RUNNER_TEMP/xcodebuild.log and prints
# only errors and the result line, so `gh run view --log-failed` stays short.
log="${RUNNER_TEMP:-/tmp}/xcodebuild.log"
xcodebuild "$@" >> "$log" 2>&1
status=$?
grep -E 'error: |\*\* [A-Z ]+ (SUCCEEDED|FAILED) \*\*' "$log" | awk '!seen[$0]++'
echo "($(grep -c 'warning: ' "$log") warning lines; full log: xcodebuild-log artifact on failure)"
if [ $status -ne 0 ]; then
  echo "--- last 40 log lines ---"
  tail -40 "$log"
fi
exit $status
