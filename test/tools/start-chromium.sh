#!/bin/bash
# Fresh Playwright Chromium with the JevBlock extension on CDP :9333, under Xvfb :98.
# Branded Chrome ignores --load-extension, hence Playwright's build.
root="$(cd "$(dirname "$0")/../.." && pwd)"
pgrep -f 'Xvfb :98' >/dev/null || (Xvfb :98 -screen 0 1280x900x24 >/dev/null 2>&1 &)
for p in $(pgrep -f 'user-data-dir=/tmp/jevblock-chromium'); do kill "$p" 2>/dev/null; done
sleep 1
rm -rf /tmp/jevblock-chromium
chrome=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)
(DISPLAY=:98 setsid "$chrome" --no-sandbox --user-data-dir=/tmp/jevblock-chromium --remote-debugging-port=9333 \
  --no-first-run --disable-extensions-except="$root/WebExtension" --load-extension="$root/WebExtension" about:blank \
  >/dev/null 2>&1 &)
sleep 4
