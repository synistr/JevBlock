const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let settings;
let defaults;
let pausedHosts = [];

function slug(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "category";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function toast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.className = isError ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ""), 2500);
}

function fitHeight(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

// ---------- categories ----------

function categoryRow(cat) {
  const row = el("div", "cat");
  // New categories get their id from the name when saved; Jev sees the id as the label.
  row.dataset.id = cat.id ?? "";
  row.dataset.builtin = cat.builtin ? "1" : "";

  const open = el("button", "cat-open");
  open.type = "button";
  const nameText = el("span", "cat-name", cat.label);
  const descText = el("span", "cat-desc", cat.description);
  open.append(nameText, descText);
  const hide = el("input", "switch hide");
  hide.type = "checkbox";
  hide.checked = !!cat.hide;
  hide.setAttribute("aria-label", `Hide ${cat.label || "this category"}`);
  hide.addEventListener("change", scheduleSave);
  const head = el("div", "cat-head");
  head.append(open, hide);

  const name = el("input", "name");
  name.type = "text";
  name.value = cat.label;
  name.placeholder = "Name";
  name.addEventListener("input", () => {
    nameText.textContent = name.value;
    hide.setAttribute("aria-label", `Hide ${name.value || "this category"}`);
    scheduleSave();
  });
  const description = el("textarea", "description");
  description.value = cat.description;
  description.rows = 2;
  description.placeholder = "What belongs in this category?";
  description.addEventListener("input", () => {
    descText.textContent = description.value;
    fitHeight(description);
    scheduleSave();
  });
  const fields = el("div", "cat-fields");
  fields.append(name, description);

  const actions = el("div", "cat-actions");
  if (cat.builtin) actions.append(el("span", "small muted", "Built in: helps Jev tell things apart"));
  else {
    const remove = el("button", "danger", "Delete");
    remove.type = "button";
    remove.addEventListener("click", () => {
      row.remove();
      save();
    });
    actions.append(remove);
  }
  const done = el("button", "done", "Done");
  done.type = "button";
  done.addEventListener("click", () => setOpen(row, false));
  actions.append(done);

  const edit = el("div", "cat-edit");
  edit.append(fields, actions);
  row.append(head, edit);
  open.addEventListener("click", () => setOpen(row, !row.classList.contains("open")));
  return row;
}

/** Opens one category's editor at a time; closing drops an untouched new one and insists on both fields otherwise. */
function setOpen(row, on) {
  if (!on) {
    const name = row.querySelector(".name");
    const description = row.querySelector(".description");
    if (!name.value.trim() && !description.value.trim() && !row.dataset.id) {
      row.remove();
      return true;
    }
    const empty = [name, description].find((f) => !f.value.trim());
    if (empty) {
      empty.focus();
      return false;
    }
    row.classList.remove("open");
    return true;
  }
  for (const other of document.querySelectorAll(".cat.open")) if (!setOpen(other, false)) return false;
  row.classList.add("open");
  fitHeight(row.querySelector(".description"));
  return true;
}

// ---------- paused sites ----------

function renderPaused() {
  const rows = pausedHosts.map((host) => {
    const row = el("div", "host");
    const remove = el("button", "remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Resume ${host}`);
    remove.addEventListener("click", () => {
      pausedHosts = pausedHosts.filter((h) => h !== host);
      renderPaused();
      save();
    });
    row.append(el("span", "", host), remove);
    return row;
  });
  $("paused").replaceChildren(...rows, $("addHost"));
}

$("addHost").addEventListener("submit", (e) => {
  e.preventDefault();
  const host = $("newHost").value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "");
  $("newHost").value = "";
  if (!host || pausedHosts.includes(host)) return;
  pausedHosts = [...pausedHosts, host];
  renderPaused();
  save();
});

// ---------- load and save ----------

function showThreshold() {
  const input = $("threshold");
  $("thresholdValue").textContent = Math.round(input.value * 100) + "% sure";
  input.style.setProperty("--pct", ((input.value - input.min) / (input.max - input.min)) * 100 + "%");
}

function render() {
  $("categories").replaceChildren(...settings.categories.map(categoryRow), $("add"));
  $("threshold").value = settings.threshold;
  showThreshold();
  $("extraSelectors").value = settings.extraSelectors;
  pausedHosts = [...settings.pausedHosts];
  renderPaused();
  $("endpoint").value = settings.endpoint;
  $("model").value = settings.model;
  $("apiKey").value = settings.apiKey;
}

function collect() {
  const rows = [...document.querySelectorAll(".cat")];
  const taken = new Set(rows.map((r) => r.dataset.id).filter(Boolean));
  const categories = rows
    .map((row) => {
      const label = row.querySelector(".name").value.trim();
      const description = row.querySelector(".description").value.trim();
      if (!label || !description) return null;
      const id = row.dataset.id || slug(label, taken);
      taken.add(id);
      const cat = { id, label, description, hide: row.querySelector(".hide").checked };
      if (row.dataset.builtin) cat.builtin = true;
      return cat;
    })
    .filter(Boolean);
  return {
    ...settings,
    categories,
    threshold: Number($("threshold").value),
    extraSelectors: $("extraSelectors").value.trim(),
    pausedHosts,
    endpoint: $("endpoint").value.trim() || defaults.endpoint,
    model: $("model").value.trim() || defaults.model,
    apiKey: $("apiKey").value.trim(),
  };
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const next = collect();
  if (next.categories.length < 2) {
    toast("Keep at least two categories.", true);
    return false;
  }
  await api.runtime.sendMessage({ type: "saveSettings", settings: next });
  settings = next;
  return true;
}

async function load() {
  const res = await api.runtime.sendMessage({ type: "getSettings" });
  settings = res.settings;
  defaults = res.defaults;
  render();
  const u = res.usage;
  if (u) {
    $("usageToday").textContent = `${u.today.toLocaleString()} tokens`;
    $("usageTotal").textContent = `${u.total.toLocaleString()} tokens`;
    $("usageRequests").textContent = u.requests.toLocaleString();
    if (!settings.model.endsWith("-free")) $("usageCost").textContent = `About $${((u.total / 1e6) * 0.042).toFixed(4)} at $0.042/M tokens.`;
  }
}

/** Destructive buttons ask for a second tap instead of a dialog. */
function confirmTap(button, prompt, action) {
  const label = button.textContent;
  let armed = false;
  let timer;
  button.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      button.textContent = prompt;
      timer = setTimeout(() => {
        armed = false;
        button.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.textContent = label;
    await action();
  });
}

$("threshold").addEventListener("input", () => {
  showThreshold();
  scheduleSave();
});
for (const id of ["extraSelectors", "endpoint", "model", "apiKey"]) $(id).addEventListener("input", scheduleSave);
$("extraSelectors").addEventListener("input", (e) => fitHeight(e.target));
$("advanced").addEventListener("toggle", () => fitHeight($("extraSelectors")));

$("add").addEventListener("click", () => {
  const row = categoryRow({ label: "", description: "", hide: true });
  $("categories").insertBefore(row, $("add"));
  if (setOpen(row, true)) row.querySelector(".name").focus();
  else row.remove();
});

$("test").addEventListener("click", async () => {
  const result = $("testResult");
  result.textContent = "Testing…";
  result.className = "foot";
  if (!(await save())) {
    result.textContent = "";
    return;
  }
  const res = await api.runtime.sendMessage({ type: "test" });
  const label = res.ok && (settings.categories.find((c) => c.id === res.verdict.label)?.label ?? res.verdict.label);
  result.textContent = res.ok
    ? `Connected in ${res.ms} ms. A sample ad came back as “${label}”, ${Math.round(res.verdict.p * 100)}% hide.`
    : res.error;
  result.className = res.ok ? "foot" : "foot error";
});

confirmTap($("clearAll"), "Tap again to forget all sites", async () => {
  await api.runtime.sendMessage({ type: "clearAll" });
  toast("All sites forgotten.");
});
confirmTap($("resetCategories"), "Tap again to restore", async () => {
  settings = { ...collect(), categories: structuredClone(defaults.categories) };
  render();
  await save();
  toast("Default categories restored.");
});

// Saving is debounced; don't lose the last keystrokes when the tab goes away.
addEventListener("pagehide", () => saveTimer && save());
document.addEventListener("visibilitychange", () => document.hidden && saveTimer && save());

load();
