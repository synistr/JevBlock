// JevBlock content script: finds elements worth asking about, describes them compactly,
// sends them to the background worker for Jev, and hides what comes back as "hide".
(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const host = location.hostname;

  const MAX_PER_PAGE = 200;
  const MAX_PER_SCAN = 40;
  const MAX_SCANS = 15;
  const RESCAN_MS = 900;
  const MAX_SELECTOR_MATCHES = 3;

  const IAB_SIZES = [
    [300, 250, "medium_rectangle"],
    [728, 90, "leaderboard"],
    [320, 50, "mobile_banner"],
    [160, 600, "wide_skyscraper"],
    [300, 600, "half_page"],
    [970, 250, "billboard"],
    [336, 280, "large_rectangle"],
    [320, 100, "large_mobile_banner"],
    [970, 90, "super_leaderboard"],
    [250, 250, "square"],
  ];
  const STRONG_TOKEN_RE =
    /(^|[^a-z0-9])(ad|ads|advert|adverts|advertisement|advertising|adsense|adslot|ad-slot|ad_slot|sponsor|sponsored|sponsorship|dfp|gpt|doubleclick|taboola|trc|outbrain|ob-widget|mgid|revcontent|zergnet|nativeads|native-ad|adsbygoogle)(?![a-z0-9])/i;
  const WEAK_TOKEN_RE = /(^|[^a-z0-9])(banner|promo|promotion|promoted|teaser|partner)(?![a-z0-9])/i;
  const OVERLAY_TOKEN_RE =
    /(cookie|consent|gdpr|cmp|privacy-banner|newsletter|subscribe|paywall|overlay|modal|popup|pop-up|interstitial|toast|drawer|sticky|app-banner|smart-banner)/i;
  const LABEL_TEXT_RE =
    /^\s*(sponsored|promoted|advertisement|advertisements|ad|ads|anzeige|werbung|gesponsert|publicidad|publicité|pubblicità|reklame|paid partnership|paid post|paid content|sponsored content|presented by)\s*[:·•\-–—]?\s*$/i;
  const ADTECH_ATTRS = [
    "data-google-query-id",
    "data-ad-client",
    "data-ad-slot",
    "data-ad-unit",
    "data-adunit",
    "data-freestar-ad",
    "data-taboola",
    "data-outbrain",
    "data-ad",
  ];
  const NEVER_IFRAME_HOSTS = [
    "stripe.com", "paypal.com", "adyen.com", "braintreegateway.com", "checkout.com", "squareup.com", "klarna.com",
    "accounts.google.com", "appleid.apple.com", "login.microsoftonline.com", "recaptcha.net", "hcaptcha.com",
    "challenges.cloudflare.com", "youtube.com", "youtube-nocookie.com", "player.vimeo.com", "open.spotify.com",
    "platform.twitter.com", "instagram.com", "disqus.com", "maps.google.com", "google.com/maps", "codepen.io",
  ];
  const TYPEABLE =
    'textarea, select, input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="checkbox"]):not([type="radio"]), [contenteditable]:not([contenteditable="false"])';
  const CLOSE_RE = /(close|dismiss|schlie|fermer|cerrar|no thanks|nein danke)/i;

  const state = {
    active: false,
    paused: false,
    error: null,
    tokens: 0,
    asked: 0,
    scans: 0,
    sensitive: false,
    rules: [],
    extra: [],
  };
  const seen = new WeakSet();
  const hidden = new Map(); // element -> label

  const send = (msg) =>
    Promise.resolve(api.runtime.sendMessage(msg)).catch((e) => ({ error: String(e?.message ?? e) }));

  // ---------- helpers ----------

  function hostnameOf(url) {
    try {
      return new URL(url, location.href).hostname || undefined;
    } catch {
      return undefined;
    }
  }

  function hostIn(h, list) {
    return !!h && list.some((d) => h === d || h.endsWith("." + d));
  }

  function clean(text, max) {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    return t ? t.slice(0, max) : undefined;
  }

  function iabOf(w, h) {
    const hit = IAB_SIZES.find(([iw, ih]) => Math.abs(w - iw) <= 4 && Math.abs(h - ih) <= 4);
    return hit?.[2];
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function tokensOf(el) {
    return `${el.id ?? ""} ${typeof el.className === "string" ? el.className : el.getAttribute("class") ?? ""}`;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 20) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
  }

  function isFixed(el) {
    const p = getComputedStyle(el).position;
    return p === "fixed" || p === "sticky";
  }

  function neverAsk(el) {
    const tag = el.tagName.toLowerCase();
    if (["html", "body", "main", "article", "head", "form"].includes(tag)) return true;
    if (el.closest('[data-jevblock="hidden"]')) return true;
    if (tag === "iframe") return hostIn(hostnameOf(el.getAttribute("src")), NEVER_IFRAME_HOSTS);
    // Anything a person can type into is never described, so typed text cannot leave the page.
    if (el.matches(TYPEABLE) || el.querySelector(TYPEABLE)) return true;
    if (el.matches("video[controls]") || el.querySelector("video[controls]")) return true;
    return false;
  }

  function isSensitivePage() {
    for (const i of document.querySelectorAll('input[type="password"], input[autocomplete^="cc-"]')) {
      const r = i.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  /** The tightest-fitting wrapper around an ad iframe/ins, so its label and whitespace go too. */
  function wrapperOf(el) {
    const base = el.getBoundingClientRect();
    const area = Math.max(1, base.width * base.height);
    let best = el;
    let cur = el.parentElement;
    for (let i = 0; cur && i < 4; i++) {
      const tag = cur.tagName.toLowerCase();
      if (["body", "main", "article", "html", "section"].includes(tag)) break;
      const r = cur.getBoundingClientRect();
      const text = (cur.innerText ?? "").trim();
      if (r.width * r.height > area * 1.6 || text.length > 40) break;
      best = cur;
      cur = cur.parentElement;
    }
    return best;
  }

  /** From a small "Sponsored" label to the card that contains it. */
  function cardOf(label) {
    let cur = label.parentElement;
    let best;
    for (let i = 0; cur && i < 7; i++) {
      const tag = cur.tagName.toLowerCase();
      if (["body", "main", "article", "html"].includes(tag)) break;
      const r = cur.getBoundingClientRect();
      const links = cur.querySelectorAll("a[href]").length;
      const text = (cur.textContent ?? "").trim().length;
      const fits = r.height >= 50 && r.width >= 150 && r.height <= 800 && links >= 1 && links <= 8 && text <= 700;
      if (fits) best = cur;
      else if (best) break;
      cur = cur.parentElement;
    }
    return best;
  }

  // ---------- discovery ----------

  function discover() {
    const found = new Map(); // element -> Set(signals)
    const add = (el, signal) => {
      if (!el || seen.has(el)) return;
      if (!found.has(el)) found.set(el, new Set());
      found.get(el).add(signal);
    };

    for (const f of document.querySelectorAll("iframe")) {
      const h = hostnameOf(f.getAttribute("src"));
      const r = f.getBoundingClientRect();
      if (r.width < 50 || r.height < 30) continue;
      if (h && h !== host && !host.endsWith("." + h)) add(wrapperOf(f), "third_party_iframe");
      else if (iabOf(r.width, r.height)) add(wrapperOf(f), "iab_size");
    }
    for (const el of document.querySelectorAll(ADTECH_ATTRS.map((a) => `[${a}]`).join(",") + ", ins.adsbygoogle")) {
      add(wrapperOf(el), "adtech_attr");
    }
    for (const el of document.querySelectorAll(
      '[class*="ad" i], [id*="ad" i], [class*="spons" i], [id*="spons" i], [class*="promo" i], [class*="banner" i], [id*="banner" i], [class*="taboola" i], [class*="outbrain" i], [data-testid*="ad" i]',
    )) {
      const t = tokensOf(el);
      if (STRONG_TOKEN_RE.test(t)) add(el, "ad_token");
      else if (WEAK_TOKEN_RE.test(t)) add(el, "weak_token");
    }
    for (const el of document.querySelectorAll(
      'body > *, [role="dialog"], [aria-modal="true"], [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="sticky" i], [class*="newsletter" i], [class*="paywall" i]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width < innerWidth * 0.4 || r.height < 40) continue;
      if (isFixed(el)) add(el, "overlay");
      else if (el.matches('[role="dialog"], [aria-modal="true"]') || OVERLAY_TOKEN_RE.test(tokensOf(el))) add(el, "overlay_token");
    }
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      if (text.length > 40 || !LABEL_TEXT_RE.test(text) || !node.parentElement) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement.tagName)) continue;
      add(cardOf(node.parentElement), "sponsored_label");
    }
    for (const a of document.querySelectorAll('a[rel~="sponsored" i]')) add(cardOf(a) ?? a, "rel_sponsored");
    for (const sel of state.extra) {
      try {
        for (const el of document.querySelectorAll(sel)) add(el, "user_selector");
      } catch {
        /* invalid selector from settings */
      }
    }

    // Keep the outermost of nested candidates (hiding it hides the rest), unless it is page-sized.
    const els = [...found.keys()].filter((el) => {
      if (neverAsk(el) || !isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return isFixed(el) || r.height < Math.max(1600, innerHeight * 2.5);
    });
    const kept = els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
    return kept.slice(0, MAX_PER_SCAN).map((el) => ({ el, signals: [...found.get(el)] }));
  }

  // ---------- description ----------

  function containerOf(el) {
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      const t = cur.tagName.toLowerCase();
      if (["main", "article", "aside", "nav", "header", "footer"].includes(t)) return t;
    }
    return "body";
  }

  function describe(el, signals) {
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const e = {
      tag,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      position: getComputedStyle(el).position,
      container: containerOf(el),
      above_fold: r.top < innerHeight && r.bottom > 0,
      signals,
    };
    const iab = iabOf(r.width, r.height);
    if (iab) e.iab = iab;
    const classes = [...el.classList].map((c) => c.slice(0, 32)).slice(0, 6);
    if (classes.length) e.classes = classes;
    if (el.id) e.id = el.id.slice(0, 48);
    const role = el.getAttribute("role");
    if (role) e.role = role.slice(0, 32);
    const aria = clean(el.getAttribute("aria-label"), 80);
    if (aria) e.aria_label = aria;

    const frame = tag === "iframe" ? el : el.querySelector("iframe[src]");
    if (frame) {
      const h = hostnameOf(frame.getAttribute("src"));
      if (h) e.iframe_host = h;
      const title = clean(frame.getAttribute("title"), 60);
      if (title) e.iframe_title = title;
    }
    const linkHosts = new Set();
    let sponsoredRel = false;
    for (const a of [...el.querySelectorAll("a[href]")].slice(0, 40)) {
      const h = hostnameOf(a.href);
      if (h && linkHosts.size < 3) linkHosts.add(h);
      if (/\bsponsored\b/i.test(a.rel)) sponsoredRel = true;
    }
    if (linkHosts.size) e.link_hosts = [...linkHosts];
    if (sponsoredRel) e.rel_sponsored = true;
    const adtech = ADTECH_ATTRS.filter((a) => el.hasAttribute(a) || el.querySelector(`[${a}]`));
    if (adtech.length) e.adtech_attrs = adtech;
    if (tag !== "iframe") {
      const text = clean(el.innerText, 150);
      if (text) e.text = text;
      const imgs = el.querySelectorAll("img, picture, svg").length;
      if (imgs) e.img_count = Math.min(imgs, 20);
      if (el.querySelector("video")) e.has_video = true;
      const closeable = [...el.querySelectorAll('button, [role="button"], a')].slice(0, 12).some((b) => {
        const label = `${b.getAttribute("aria-label") ?? ""} ${b.title ?? ""} ${tokensOf(b)} ${(b.textContent ?? "").trim().slice(0, 12)}`;
        return CLOSE_RE.test(label) || /^[×✕✖x]$/i.test((b.textContent ?? "").trim());
      });
      if (closeable) e.has_close_control = true;
    }
    return e;
  }

  function fingerprint(e) {
    const [w, h] = e.size.split("x").map((n) => Math.round(Number(n) / 40));
    return hash(
      JSON.stringify([
        e.tag,
        e.iab ?? `${w}x${h}`,
        (e.classes ?? []).map((c) => c.replace(/\d+/g, "#")).sort(),
        e.iframe_host,
        e.link_hosts,
        (e.text ?? "").slice(0, 80).replace(/\d+/g, "#"),
        e.position,
      ]),
    );
  }

  /** A selector that is stable across loads and matches only a few elements, for pre-paint rules. */
  function stableSelector(el) {
    const tag = el.tagName.toLowerCase();
    const tryIt = (sel) => {
      try {
        const matches = document.querySelectorAll(sel);
        if (matches.length && matches.length <= MAX_SELECTOR_MATCHES && [...matches].includes(el)) return sel;
      } catch {
        /* invalid */
      }
      return undefined;
    };
    if (el.id && !/\d{3,}/.test(el.id)) {
      const s = tryIt(`#${CSS.escape(el.id)}`);
      if (s) return s;
    }
    const classes = [...el.classList].filter((c) => !/\d{3,}/.test(c) && c.length < 40);
    if (classes.length >= 2) {
      const s = tryIt(`${tag}.${classes.slice(0, 3).map((c) => CSS.escape(c)).join(".")}`);
      if (s) return s;
    }
    for (const attr of ["data-ad-slot", "data-ad-unit", "data-adunit", "data-testid", "data-module", "data-component"]) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 40) continue;
      const s = tryIt(`${tag}[${attr}="${CSS.escape(v)}"]`);
      if (s) return s;
    }
    return undefined;
  }

  // ---------- hiding ----------

  function hide(el, label) {
    const wasFixed = isFixed(el);
    el.setAttribute("data-jevblock", "hidden");
    el.setAttribute("data-jevblock-label", label ?? "");
    hidden.set(el, label);
    if (wasFixed) {
      const locked = [document.documentElement, document.body].some((n) => n && getComputedStyle(n).overflow === "hidden");
      if (locked) document.documentElement.setAttribute("data-jevblock-unlock", "");
    }
  }

  function applyRules(rules) {
    state.rules = rules;
    if (!rules.length) return;
    const style = document.createElement("style");
    style.setAttribute("data-jevblock-rules", "");
    style.textContent = rules.map((sel) => `${sel} { display: none !important; }`).join("\n");
    (document.head ?? document.documentElement).appendChild(style);
  }

  function hiddenCount() {
    let n = hidden.size;
    for (const sel of state.rules) {
      try {
        for (const el of document.querySelectorAll(sel)) if (!hidden.has(el)) n++;
      } catch {
        /* invalid */
      }
    }
    return n;
  }

  // ---------- scanning ----------

  let scanTimer;
  let scanning = false;

  function scheduleScan(delay = RESCAN_MS) {
    if (!state.active || state.scans >= MAX_SCANS || state.asked >= MAX_PER_PAGE) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  async function scan() {
    if (scanning) return scheduleScan();
    scanning = true;
    state.scans++;
    try {
      if (isSensitivePage()) {
        state.sensitive = true;
        return;
      }
      state.sensitive = false;
      const found = discover().slice(0, MAX_PER_PAGE - state.asked);
      if (!found.length) return;
      const byFp = new Map();
      const candidates = [];
      for (const { el, signals } of found) {
        seen.add(el);
        const entry = describe(el, signals);
        const fp = fingerprint(entry);
        if (!byFp.has(fp)) {
          byFp.set(fp, []);
          const sel = stableSelector(el);
          candidates.push(sel ? { fp, sel, entry } : { fp, entry });
        }
        byFp.get(fp).push(el);
      }
      state.asked += found.length;
      const page = { host, title: clean(document.title, 120), lang: document.documentElement.lang?.slice(0, 8) || undefined };
      const res = await send({ type: "classify", host, page, candidates });
      state.error = res?.error ?? null;
      state.tokens += res?.tokens ?? 0;
      for (const v of res?.verdicts ?? []) {
        if (!v.hide) continue;
        for (const el of byFp.get(v.fp) ?? []) hide(el, v.label);
      }
      send({ type: "badge", count: hiddenCount() });
    } finally {
      scanning = false;
    }
  }

  function start() {
    scheduleScan(250);
    addEventListener("load", () => scheduleScan(500), { once: true });
    new MutationObserver((records) => {
      if (records.some((r) => r.addedNodes.length)) scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- messages from the popup ----------

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "stats") {
      const byLabel = {};
      for (const label of hidden.values()) byLabel[label] = (byLabel[label] ?? 0) + 1;
      const ruleOnly = hiddenCount() - hidden.size;
      if (ruleOnly > 0) byLabel.__rules = ruleOnly;
      sendResponse({
        host,
        active: state.active,
        paused: state.paused,
        sensitive: state.sensitive,
        error: state.error,
        tokens: state.tokens,
        asked: state.asked,
        hidden: hiddenCount(),
        byLabel,
        reveal: document.documentElement.hasAttribute("data-jevblock-reveal"),
      });
    } else if (msg?.type === "reveal") {
      document.documentElement.toggleAttribute("data-jevblock-reveal", !!msg.on);
      if (msg.on) {
        for (const [el, label] of hidden) el.title = `JevBlock: ${label}`;
      }
      sendResponse({ ok: true });
    }
    return false;
  });

  send({ type: "init", host }).then((res) => {
    if (res?.error) {
      state.error = res.error;
      return;
    }
    if (!res?.active) {
      state.paused = true;
      return;
    }
    state.active = true;
    state.extra = (res.extraSelectors ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    applyRules(res.rules ?? []);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  });
})();
