const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function askTab(tabId, msg) {
  return Promise.resolve(api.tabs.sendMessage(tabId, msg)).catch(() => null);
}

async function main() {
  const tab = await activeTab();
  const host = tab?.url ? new URL(tab.url).hostname : "";
  $("host").textContent = host;
  const [{ settings }, stats, { paused }] = await Promise.all([
    api.runtime.sendMessage({ type: "getSettings" }),
    tab ? askTab(tab.id, { type: "stats" }) : null,
    api.runtime.sendMessage({ type: "isPaused", host }),
  ]);
  const names = Object.fromEntries(settings.categories.map((c) => [c.id, c.label]));
  names.__rules = "Remembered from earlier visits";

  $("pause").checked = paused;
  if (!stats) {
    $("status").textContent = "JevBlock isn't running on this page. Allow it for this website in Safari's extension settings.";
    $("reveal").disabled = true;
    return;
  }
  $("count").textContent = stats.hidden;
  $("reveal").checked = stats.reveal;
  $("labels").replaceChildren(
    ...Object.entries(stats.byLabel)
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = names[label] ?? label;
        const count = document.createElement("span");
        count.className = "muted";
        count.textContent = n;
        li.append(name, count);
        return li;
      }),
  );

  const status = $("status");
  if (stats.paused) status.textContent = "Paused on this site.";
  else if (stats.sensitive) status.textContent = "Skipped: this page has a password or payment field.";
  else if (stats.error) {
    status.textContent = stats.error;
    status.className = "error small";
  } else status.textContent = `Checked ${stats.asked} elements · ${stats.tokens.toLocaleString()} tokens`;
}

$("reveal").addEventListener("change", async (e) => {
  const tab = await activeTab();
  await askTab(tab.id, { type: "reveal", on: e.target.checked });
});

$("pause").addEventListener("change", async (e) => {
  const tab = await activeTab();
  await api.runtime.sendMessage({ type: "setPaused", host: new URL(tab.url).hostname, paused: e.target.checked });
  api.tabs.reload(tab.id);
  window.close();
});

$("reset").addEventListener("click", async () => {
  const tab = await activeTab();
  await api.runtime.sendMessage({ type: "resetSite", host: new URL(tab.url).hostname });
  api.tabs.reload(tab.id);
  window.close();
});

$("settings").addEventListener("click", () => {
  api.tabs.create({ url: api.runtime.getURL("options.html") });
  window.close();
});

main();
