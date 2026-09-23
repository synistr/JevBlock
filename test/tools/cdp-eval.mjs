// node cdp-eval.mjs <target-url-substring> <expression>: evaluate in a CDP target (page or extension worker).
// With several matches (e.g. "/background.js"), JevBlock's worker (the one exposing __jevblock) wins.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const [, , match, expr] = process.argv;
const list = async () => (await (await fetch("http://127.0.0.1:9333/json/list")).json()).filter((t) => t.url.includes(match));

/** Chrome's ID for an unpacked extension: sha256 of its path, first 32 hex digits mapped to a–p. */
function extensionId() {
  const dir = resolve(fileURLToPath(import.meta.url), "../../../WebExtension");
  return [...createHash("sha256").update(dir).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

let targets = await list();
if (!targets.length) {
  // MV3 workers stop when idle; opening the settings page wakes JevBlock's.
  const version = await (await fetch("http://127.0.0.1:9333/json/version")).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: `chrome-extension://${extensionId()}/options.html` } }));
  for (let i = 0; i < 20 && !targets.length; i++) {
    await new Promise((r) => setTimeout(r, 300));
    targets = await list();
  }
  ws.close();
}
if (!targets.length) { console.log("no target matching", match); process.exit(1); }

async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  const result = await new Promise((res) => {
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return result;
}

let target = targets[0];
if (targets.length > 1) {
  for (const t of targets) if ((await evaluate(t, "typeof __jevblock !== 'undefined'"))?.result?.value) target = t;
}
const r = await evaluate(target, expr);
console.log(JSON.stringify(r?.result?.value ?? r, null, 1).slice(0, 6000));
process.exit(0);
