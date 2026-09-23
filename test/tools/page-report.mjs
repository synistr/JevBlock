// node page-report.mjs <url> [shotPrefix]: iPhone-sized page load + scroll, then what JevBlock hid. Needs start-chromium.sh.
import { writeFileSync } from "node:fs";
const [, , url, shot] = process.argv;
const base = "http://127.0.0.1:9333";
const version = await (await fetch(base + "/json/version")).json();
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => bws.addEventListener("open", r));
let bid = 0;
const bcall = (method, params = {}) => new Promise((res) => {
  const id = ++bid; const h = (m) => { const d = JSON.parse(m.data); if (d.id === id) { bws.removeEventListener("message", h); res(d.result ?? d.error); } };
  bws.addEventListener("message", h); bws.send(JSON.stringify({ id, method, params }));
});
const { targetId } = await bcall("Target.createTarget", { url: "about:blank" });
const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${targetId}`);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const call = (method, params = {}) => new Promise((res) => {
  const i = ++id; const h = (m) => { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", h); res(d.result ?? d.error); } };
  ws.addEventListener("message", h); ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await call("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
await call("Emulation.setTouchEmulationEnabled", { enabled: true });
await call("Page.enable");
const t0 = Date.now();
await call("Page.navigate", { url });
await sleep(9000);
if (shot) { await call("Page.bringToFront"); const s = await call("Page.captureScreenshot", { format: "jpeg", quality: 60 }); writeFileSync(`${shot}-0.jpg`, Buffer.from(s.data, "base64")); }
for (let i = 1; i <= 5; i++) { await evaluate("window.scrollBy(0, innerHeight * 0.9); 1"); await sleep(2500); }
if (shot) { await call("Page.bringToFront"); const s = await call("Page.captureScreenshot", { format: "jpeg", quality: 60 }); writeFileSync(`${shot}-1.jpg`, Buffer.from(s.data, "base64")); }
const report = await evaluate(`(() => {
  const short = (s, n) => (s ?? "").toString().replace(/\\s+/g, " ").trim().slice(0, n);
  const hidden = [...document.querySelectorAll('[data-jevblock="hidden"]')].map(e => {
    e.style.setProperty("display", "revert", "important"); const r = e.getBoundingClientRect(); e.style.removeProperty("display");
    return e.getAttribute("data-jevblock-seen") + " | " + e.localName + "." + short(e.className, 30) + (e.id ? "#" + short(e.id, 25) : "") + " " + Math.round(r.width) + "x" + Math.round(r.height) + " | " + short(e.innerText, 70);
  });
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width >= 50 && r.height >= 30 && !e.closest('[data-jevblock="hidden"]') && getComputedStyle(e).visibility !== "hidden"; };
  const host = location.hostname.split(".").slice(-2).join(".");
  const missed = [...document.querySelectorAll("iframe, ins.adsbygoogle, [data-google-query-id], [data-ad-slot], [id^=div-gpt-ad], [class*=taboola], [id*=taboola], [class*=outbrain]")]
    .filter(vis).filter(e => { const s = e.src ? new URL(e.src, location.href).hostname : ""; return e.localName !== "iframe" || (s && !s.endsWith(host)); })
    .map(e => e.localName + " " + short(e.src || e.id || e.className, 70) + " " + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height));
  return { debug: document.documentElement.getAttribute("data-jevblock-debug"), title: short(document.title, 60), hiddenCount: hidden.length, hidden, missed: missed.slice(0, 15), rules: document.querySelector("style[data-jevblock-rules]")?.textContent.split("\\n").length ?? 0 };
})()`);
console.log(JSON.stringify({ url, seconds: Math.round((Date.now() - t0) / 1000), ...report }, null, 1));
await bcall("Target.closeTarget", { targetId });
process.exit(0);
