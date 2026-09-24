const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let settings;
let defaults;
let categories = [];
let pausedHosts = [];
let editing = null; // index into categories, or "new"

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

function button(text, className, onClick, type = "button") {
  const b = el("button", className, text);
  b.type = type;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function toast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.className = isError ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2000);
}

// ---------- categories ----------

function categoryItem(cat, i) {
  const li = el("li", "cat");
  const main = el("label", "cat-main");
  const check = el("input", "check");
  check.type = "checkbox";
  check.checked = !!cat.hide;
  check.addEventListener("change", () => {
    cat.hide = check.checked;
    save();
  });
  const text = el("span");
  const name = el("span", "cat-name", cat.label);
  if (cat.builtin) name.append(el("span", "tag", "built in"));
  text.append(name, el("span", "cat-desc", cat.description));
  main.append(check, text);
  const edit = button("Edit", "link edit", () => {
    editing = i;
    renderCategories();
  });
  edit.disabled = editing !== null;
  edit.setAttribute("aria-label", `Edit ${cat.label}`);
  li.append(main, edit);
  return li;
}

function categoryForm(cat, isNew) {
  const li = el("li", "cat");
  const form = el("form");
  const nameField = el("label", "field");
  const name = el("input");
  name.type = "text";
  name.value = cat.label;
  name.placeholder = "Recipe life stories";
  nameField.append(el("span", "", "Name"), name);
  const descField = el("label", "field");
  const description = el("textarea");
  description.rows = 6;
  description.value = cat.description;
  description.placeholder = "Long personal stories that come before the actual recipe";
  descField.append(el("span", "", "What belongs in it"), description);
  const hint = el(
    "p",
    "hint small muted",
    cat.builtin
      ? "Built in: Jev puts things you keep here, so they aren't forced into a hidden category. Keep it narrow: anything it mentions can't be hidden by your own categories."
      : "Describe it the way you'd explain it to a person.",
  );
  const problem = el("p", "error small");
  problem.hidden = true;

  const actions = el("div", "form-actions");
  if (!isNew && !cat.builtin) {
    actions.append(
      button("Delete", "link danger", () => {
        categories = categories.filter((c) => c !== cat);
        editing = null;
        renderCategories();
        save();
      }),
    );
  }
  actions.append(
    button("Cancel", "", () => {
      editing = null;
      renderCategories();
    }),
    button("Save", "primary", null, "submit"),
  );
  if (!actions.querySelector(".danger")) actions.firstChild.style.marginLeft = "auto";

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const label = name.value.trim();
    const desc = description.value.trim();
    if (!label || !desc) {
      problem.textContent = "Give the category a name and a description.";
      problem.hidden = false;
      (label ? description : name).focus();
      return;
    }
    if (isNew) {
      const id = slug(label, new Set(categories.map((c) => c.id)));
      categories.push({ id, label, description: desc, hide: true });
    } else Object.assign(cat, { label, description: desc });
    editing = null;
    renderCategories();
    save();
  });

  form.append(nameField, descField, hint, problem, actions);
  li.append(form);
  requestAnimationFrame(() => name.focus({ preventScroll: !isNew }));
  return li;
}

function renderCategories() {
  const items = categories.map((cat, i) => (editing === i ? categoryForm(cat, false) : categoryItem(cat, i)));
  if (editing === "new") items.push(categoryForm({ label: "", description: "" }, true));
  $("categories").replaceChildren(...items);
  $("add").hidden = editing === "new";
  $("add").disabled = editing !== null;
}

// ---------- paused sites ----------

function renderHosts() {
  $("hosts").replaceChildren(
    ...pausedHosts.map((host) => {
      const li = el("li");
      const remove = button("×", "", () => {
        pausedHosts = pausedHosts.filter((h) => h !== host);
        renderHosts();
        save();
      });
      remove.setAttribute("aria-label", `Resume ${host}`);
      li.append(el("span", "", host), remove);
      return li;
    }),
  );
}

$("addHost").addEventListener("submit", (e) => {
  e.preventDefault();
  const host = $("newHost").value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "");
  $("newHost").value = "";
  if (!host || pausedHosts.includes(host)) return;
  pausedHosts = [...pausedHosts, host];
  renderHosts();
  save();
});

// ---------- load and save ----------

function showThreshold() {
  const input = $("threshold");
  $("thresholdValue").textContent = Math.round(input.value * 100) + "%";
  input.style.setProperty("--pct", ((input.value - input.min) / (input.max - input.min)) * 100 + "%");
}

function render() {
  categories = structuredClone(settings.categories);
  editing = null;
  renderCategories();
  pausedHosts = [...settings.pausedHosts];
  renderHosts();
  $("threshold").value = settings.threshold;
  showThreshold();
  $("extraSelectors").value = settings.extraSelectors;
  $("endpoint").value = settings.endpoint;
  $("model").value = settings.model;
  $("apiKey").value = settings.apiKey;
}

function collect() {
  return {
    ...settings,
    categories: structuredClone(categories),
    threshold: Number($("threshold").value),
    extraSelectors: $("extraSelectors").value.trim(),
    pausedHosts,
    endpoint: $("endpoint").value.trim() || defaults.endpoint,
    model: $("model").value.trim() || defaults.model,
    apiKey: $("apiKey").value.trim(),
  };
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
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
  toast("Saved. Reload pages to apply.");
  return true;
}

async function load() {
  const res = await api.runtime.sendMessage({ type: "getSettings" });
  settings = res.settings;
  defaults = res.defaults;
  render();
  const u = res.usage;
  if (u?.requests) {
    const cost = settings.model.endsWith("-free") ? "" : ` About $${((u.total / 1e6) * 0.042).toFixed(4)} at $0.042 per million.`;
    setTextWithNumbers(
      $("usage"),
      `${u.today.toLocaleString()} tokens used today, ${u.total.toLocaleString()} in total over ${u.requests.toLocaleString()} requests.` + cost,
    );
  }
}

/** Destructive buttons ask for a second tap instead of a dialog. */
function confirmTap(b, prompt, action) {
  const label = b.textContent;
  let timer = null;
  b.addEventListener("click", async () => {
    if (!timer) {
      b.textContent = prompt;
      timer = setTimeout(() => {
        timer = null;
        b.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    b.textContent = label;
    await action();
  });
}

$("threshold").addEventListener("input", () => {
  showThreshold();
  scheduleSave();
});
for (const id of ["extraSelectors", "endpoint", "model", "apiKey"]) $(id).addEventListener("input", scheduleSave);

$("add").addEventListener("click", () => {
  editing = "new";
  renderCategories();
});

$("test").addEventListener("click", async () => {
  const result = $("testResult");
  result.textContent = "Testing…";
  result.className = "muted";
  if (!(await save())) {
    result.textContent = "";
    return;
  }
  const res = await api.runtime.sendMessage({ type: "test" });
  if (res.ok) {
    const label = categories.find((c) => c.id === res.verdict.label)?.label ?? res.verdict.label;
    setTextWithNumbers(result, `Connected in ${res.ms} ms. A sample ad came back as “${label}”.`);
  } else result.textContent = res.error;
  result.className = res.ok ? "muted" : "error";
});

confirmTap($("clearAll"), "Tap again to forget all sites", async () => {
  await api.runtime.sendMessage({ type: "clearAll" });
  toast("All sites forgotten");
});
confirmTap($("resetCategories"), "Tap again to restore", async () => {
  settings = { ...collect(), categories: defaults.categories };
  render();
  await save();
  toast("Default categories restored");
});

// ---------- menu ----------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function showTab(tab, focus) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute("aria-selected", selected);
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !selected;
  }
  history.replaceState(null, "", "#" + tab.id.replace("tab-", ""));
  scrollTo(0, 0);
  if (focus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showTab(tab));
  tab.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) showTab(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length], true);
  });
}
showTab($("tab-" + location.hash.slice(1)) ?? tabs[0]);

// Typing saves after a pause; don't lose the last keystrokes when the tab goes away.
addEventListener("pagehide", () => saveTimer && save());
document.addEventListener("visibilitychange", () => document.hidden && saveTimer && save());

load();
