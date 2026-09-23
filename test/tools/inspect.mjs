// node inspect.mjs <url> <expression>: iPhone-sized page, waits 9s (SCROLL=1 also scrolls), evaluates expression.
const [, , url, expr] = process.argv;
const version = await (await fetch("http://127.0.0.1:9333/json/version")).json();
const bws = new WebSocket(version.webSocketDebuggerUrl); await new Promise((r) => bws.addEventListener("open", r));
let bid = 0; const bcall = (method, params = {}) => new Promise((res) => { const id = ++bid; const h = (m) => { const d = JSON.parse(m.data); if (d.id === id) { bws.removeEventListener("message", h); res(d.result ?? d.error); } }; bws.addEventListener("message", h); bws.send(JSON.stringify({ id, method, params })); });
const { targetId } = await bcall("Target.createTarget", { url: "about:blank" });
const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${targetId}`); await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const call = (method, params = {}) => new Promise((res) => { const i = ++id; const h = (m) => { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", h); res(d.result ?? d.error); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await call("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
await call("Page.navigate", { url }); await new Promise((r) => setTimeout(r, 9000));
if (process.env.SCROLL) for (let i = 0; i < 5; i++) { await call("Runtime.evaluate", { expression: "window.scrollBy(0, innerHeight * 0.9)" }); await new Promise((r) => setTimeout(r, 2500)); }
const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r?.result?.value ?? r, null, 1));
await bcall("Target.closeTarget", { targetId }); process.exit(0);
