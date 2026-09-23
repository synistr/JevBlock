const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let settings;
let defaults;

function slug(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "category";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

function categoryRow(cat) {
  const row = document.createElement("div");
  row.className = "category";
  row.dataset.id = cat.id ?? "";
  row.dataset.builtin = cat.builtin ? "1" : "";

  const top = document.createElement("div");
  top.className = "top";
  const name = document.createElement("input");
  name.type = "text";
  name.value = cat.label;
  name.placeholder = "Name";
  name.className = "name";
  const hide = document.createElement("input");
  hide.type = "checkbox";
  hide.className = "switch hide";
  hide.checked = !!cat.hide;
  hide.title = "Hide elements in this category";
  top.append(name, hide);

  const description = document.createElement("textarea");
  description.className = "description";
  description.value = cat.description;
  description.placeholder = "What belongs in this category?";

  const bottom = document.createElement("div");
  bottom.className = "bottom";
  const note = document.createElement("span");
  note.className = "muted small";
  note.textContent = cat.builtin ? "Built in: helps Jev tell things apart" : "";
  bottom.append(note);
  if (!cat.builtin) {
    const remove = document.createElement("button");
    remove.className = "danger small";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => row.remove());
    bottom.append(remove);
  }
  row.append(top, description, bottom);
  return row;
}

function render() {
  $("categories").replaceChildren(...settings.categories.map(categoryRow));
  $("threshold").value = settings.threshold;
  $("thresholdValue").textContent = Math.round(settings.threshold * 100) + "%";
  $("extraSelectors").value = settings.extraSelectors;
  $("pausedHosts").value = settings.pausedHosts.join("\n");
  $("endpoint").value = settings.endpoint;
  $("model").value = settings.model;
  $("apiKey").value = settings.apiKey;
}

function collect() {
  const rows = [...document.querySelectorAll(".category")];
  const taken = new Set(rows.map((r) => r.dataset.id).filter(Boolean));
  const categories = rows
    .map((row) => {
      const label = row.querySelector(".name").value.trim();
      const description = row.querySelector(".description").value.trim();
      if (!label || !description) return null;
      let id = row.dataset.id;
      if (!id) {
        id = slug(label, taken);
        taken.add(id);
        row.dataset.id = id;
      }
      const cat = { id, label, description, hide: row.querySelector(".hide").checked };
      if (row.dataset.builtin) cat.builtin = true;
      return cat;
    })
    .filter(Boolean);
  const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    ...settings,
    categories,
    threshold: Number($("threshold").value),
    extraSelectors: $("extraSelectors").value.trim(),
    pausedHosts: lines($("pausedHosts").value).map((h) => h.replace(/^https?:\/\//, "").replace(/\/.*$/, "")),
    endpoint: $("endpoint").value.trim() || defaults.endpoint,
    model: $("model").value.trim() || defaults.model,
    apiKey: $("apiKey").value.trim(),
  };
}

async function save() {
  const next = collect();
  if (next.categories.length < 2) {
    $("saved").textContent = "Keep at least two categories.";
    return false;
  }
  await api.runtime.sendMessage({ type: "saveSettings", settings: next });
  settings = next;
  $("saved").textContent = "Saved. Reload pages to apply.";
  return true;
}

async function load() {
  const res = await api.runtime.sendMessage({ type: "getSettings" });
  settings = res.settings;
  defaults = res.defaults;
  render();
  const u = res.usage;
  $("usage").textContent = u
    ? `${u.today.toLocaleString()} tokens today · ${u.total.toLocaleString()} total in ${u.requests.toLocaleString()} requests` +
      (settings.model.endsWith("-free") ? "" : ` · about $${((u.total / 1e6) * 0.042).toFixed(4)} at $0.042/M`)
    : "";
}

$("threshold").addEventListener("input", (e) => {
  $("thresholdValue").textContent = Math.round(Number(e.target.value) * 100) + "%";
});
$("add").addEventListener("click", () => {
  const row = categoryRow({ label: "", description: "", hide: true });
  $("categories").append(row);
  row.querySelector(".name").focus();
});
$("save").addEventListener("click", save);
$("test").addEventListener("click", async () => {
  $("testResult").textContent = "Testing…";
  $("testResult").className = "muted small";
  if (!(await save())) return;
  const res = await api.runtime.sendMessage({ type: "test" });
  $("testResult").textContent = res.ok
    ? `OK in ${res.ms} ms (sample ad → ${res.verdict.label}, ${Math.round(res.verdict.p * 100)}% hide)`
    : res.error;
  $("testResult").className = res.ok ? "muted small" : "error small";
});
$("clearAll").addEventListener("click", async () => {
  await api.runtime.sendMessage({ type: "clearAll" });
  $("saved").textContent = "Cleared.";
});
$("resetCategories").addEventListener("click", () => {
  settings = { ...collect(), categories: structuredClone(defaults.categories) };
  render();
  $("saved").textContent = "Not saved yet.";
});

load();
