// node timings.mjs <url>...: loads each URL twice (fresh, then with the site remembered) iPhone-sized
// and prints JevBlock's debug marks (ms since navigation start) next to DOMContentLoaded.
// Needs start-chromium.sh and the debug setting on.
const version = await (await fetch("http://127.0.0.1:9333/json/version")).json();
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => bws.addEventListener("open", r));
let bid = 0;
const bcall = (method, params = {}) => new Promise((res) => {
  const i = ++bid; const h = (m) => { const d = JSON.parse(m.data); if (d.id === i) { bws.removeEventListener("message", h); res(d.result ?? d.error); } };
  bws.addEventListener("message", h); bws.send(JSON.stringify({ id: i, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(url) {
  const { targetId } = await bcall("Target.createTarget", { url: "about:blank" });
  const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${targetId}`);
  await new Promise((r) => ws.addEventListener("open", r));
  let n = 0;
  const call = (method, params = {}) => new Promise((res) => {
    const i = ++n; const h = (m) => { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", h); res(d.result ?? d.error); } };
    ws.addEventListener("message", h); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await call("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
  await call("Page.navigate", { url });
  await sleep(12000);
  const r = await call("Runtime.evaluate", {
    returnByValue: true,
    expression: `({ dcl: Math.round(performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0), ...JSON.parse(document.documentElement.getAttribute("data-jevblock-debug") || "{}"), hidden: document.querySelectorAll('[data-jevblock="hidden"]').length })`,
  });
  await bcall("Target.closeTarget", { targetId });
  return r?.result?.value ?? {};
}

for (const url of process.argv.slice(2)) {
  for (const visit of ["fresh", ...Array(Number(process.env.REPEAT ?? 1)).fill("remembered")]) {
    const v = await load(url);
    const cols = ["dcl", "rules", "firstScan", "firstRequest", "firstHide", "hidden", "maxScanMs"].map((k) => `${k}=${v[k] ?? "-"}`).join("  ");
    console.log(`${new URL(url).hostname.padEnd(28)} ${visit.padEnd(10)} ${cols}`);
  }
}
process.exit(0);
