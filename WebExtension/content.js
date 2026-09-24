// JevBlock content script: splits the page into blocks, describes each compactly, sends them to the
// background worker for Jev, and hides what comes back as "hide". Ad-looking clues are hints in the
// description and add nested elements of their own; they are not a gate for what Jev sees.
(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const host = location.hostname;

  const MAX_PER_PAGE = 800; // elements asked about per page load (repeats of a known kind are free)
  const MAX_PER_SCAN = 120;
  const MAX_SCANS = 300;
  const MAX_WALK = 12000; // nodes visited per segmentation pass
  const MAX_CHECKS = 3; // an element is asked about again when it changes, at most this often
  const RESCAN_MS = 1000;
  const CHUNK = 30; // candidates per classify message: one Jev request each
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
    "platform.twitter.com", "instagram.com", "disqus.com", "maps.google.com", "codepen.io",
  ];
  // Where typed text lives in the DOM (and so in innerText). Plain inputs keep their value out of it.
  const TYPED_TEXT = 'textarea, [contenteditable]:not([contenteditable="false"])';
  const CLOSE_RE = /(close|dismiss|schlie|fermer|cerrar|no thanks|nein danke)/i;
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "link", "meta", "br", "hr", "head", "option"]);
  const PROSE_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "dl", "figcaption", "code"]);
  const MEDIA_TAGS = new Set(["img", "picture", "svg", "video", "canvas", "audio"]);
  const NEVER_BLOCK_TAGS = new Set(["html", "body", "main", "form", "input", "select", "textarea", "button", "label"]);

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
    debug: false,
    scanMs: 0,
    maxScanMs: 0,
    marks: {}, // debug: ms since navigation start for rules applied, first request, first hide
  };

  function mark(name) {
    if (!(name in state.marks)) state.marks[name] = Math.round(performance.now());
  }

  function debugOut() {
    if (!state.debug) return;
    const { scans, scanMs, maxScanMs, asked, tokens, marks } = state;
    document.documentElement.setAttribute("data-jevblock-debug", JSON.stringify({ scans, scanMs, maxScanMs, asked, tokens, ...marks }));
  }
  const checked = new WeakMap(); // element -> { fp, n }
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

  /** Same site, ignoring www./m. and similar subdomain differences. */
  function sameSite(h) {
    if (!h) return true;
    const base = (x) => x.split(".").slice(-2).join(".");
    return base(h) === base(host);
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

  function isFixed(el) {
    const p = getComputedStyle(el).position;
    return p === "fixed" || p === "sticky";
  }

  function inRange(r) {
    return r.bottom > -innerHeight && r.top < innerHeight * 3;
  }

  function neverAsk(el) {
    const tag = el.localName;
    if (NEVER_BLOCK_TAGS.has(tag)) return true;
    if (el.closest('[data-jevblock="hidden"]')) return true;
    if (tag === "iframe") return hostIn(hostnameOf(el.getAttribute("src")), NEVER_IFRAME_HOSTS);
    // Never describe something holding typed text, or what the user is typing into right now.
    if (el.matches(TYPED_TEXT) || el.querySelector(TYPED_TEXT)) return true;
    const typing = document.activeElement?.matches?.('input, select, ' + TYPED_TEXT) ? document.activeElement : null;
    if (typing && el.contains(typing)) return true;
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
      if (["body", "main", "article", "html", "section"].includes(cur.localName)) break;
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
      if (["body", "main", "article", "html"].includes(cur.localName)) break;
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

  // ---------- segmentation: the whole page as blocks ----------

  const blockSized = (r) => r.width >= 60 && r.height >= 30;

  /** Lists, grids, feeds and article bodies: several same-tag, same-width children. */
  function isRepeating(kids) {
    if (kids.length >= 6) return true;
    const groups = new Map();
    for (const { el, r } of kids) {
      const key = `${el.localName}:${Math.round(r.width / 24)}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return Math.max(0, ...groups.values()) >= 3;
  }

  /** Plain article text: asking about it costs tokens and never changes the verdict. */
  function isProse(el) {
    if (!PROSE_TAGS.has(el.localName) || el.querySelector("iframe")) return false;
    let linkText = 0;
    for (const a of el.querySelectorAll("a[href]")) {
      if (!sameSite(hostnameOf(a.href))) return false;
      linkText += (a.textContent ?? "").length;
    }
    return linkText < (el.textContent ?? "").length * 0.6;
  }

  function mediaWorthAsking(el) {
    const link = el.closest("a[href]");
    return !!link && !sameSite(hostnameOf(link.href));
  }

  /**
   * Walks the page top-down. Page-sized containers and repeating lists are split into their children;
   * anything card- to widget-sized becomes one block. Fixed and sticky layers are always blocks.
   */
  function segment() {
    const vw = innerWidth;
    const vh = innerHeight;
    const blocks = [];
    let visited = 0;

    const visit = (el, depth) => {
      if (visited++ > MAX_WALK || depth > 60 || SKIP_TAGS.has(el.localName)) return;
      if (el.getAttribute("data-jevblock") === "hidden") return;
      const style = getComputedStyle(el);
      if (style.display === "none") return;
      if (style.display === "contents") return walk(el, depth);
      const r = el.getBoundingClientRect();
      const fixed = style.position === "fixed" || style.position === "sticky";
      if (!fixed && !inRange(r)) return;

      if (fixed && r.width >= 100 && r.height >= 30 && r.height <= vh * 1.5) {
        if (style.visibility !== "hidden" && Number(style.opacity) > 0.05) blocks.push(el);
        return;
      }
      if (!blockSized(r)) return walk(el, depth); // tiny wrappers can still hold positioned layers
      if (isProse(el)) return; // however long: its links and spans are words, not blocks
      if (style.display === "inline") return walk(el, depth);
      const big = r.height > vh || r.width * r.height > vw * vh * 0.55;
      if (big || NEVER_BLOCK_TAGS.has(el.localName)) return walk(el, depth);
      const kids = [];
      for (const c of el.children) {
        const cr = c.getBoundingClientRect();
        if (blockSized(cr)) kids.push({ el: c, r: cr });
      }
      if (kids.length >= 3 && isRepeating(kids)) return walk(el, depth);
      if (style.visibility === "hidden" || Number(style.opacity) <= 0.05) return;
      if (MEDIA_TAGS.has(el.localName) && !mediaWorthAsking(el)) return;
      blocks.push(el);
    };
    const walk = (el, depth) => {
      for (const c of el.children) visit(c, depth + 1);
      if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c, depth + 1);
    };

    if (document.body) walk(document.body, 0);
    return blocks;
  }

  // ---------- clues: ad-looking elements, also when nested inside a block ----------

  function clues() {
    const found = new Map(); // element -> Set(signals)
    const add = (el, signal) => {
      if (!el) return;
      if (!found.has(el)) found.set(el, new Set());
      found.get(el).add(signal);
    };

    for (const f of document.querySelectorAll("iframe")) {
      const r = f.getBoundingClientRect();
      if (r.width < 50 || r.height < 30) continue;
      if (!sameSite(hostnameOf(f.getAttribute("src")))) add(wrapperOf(f), "third_party_iframe");
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
      '[role="dialog"], [aria-modal="true"], [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="newsletter" i], [class*="paywall" i]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width >= innerWidth * 0.4 && r.height >= 40) add(el, "overlay_token");
    }
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      if (text.length > 40 || !LABEL_TEXT_RE.test(text) || !node.parentElement) continue;
      if (SKIP_TAGS.has(node.parentElement.localName)) continue;
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
    return found;
  }

  /** Signals that hint at what an element is, whether it was found by segmenting or by a clue. */
  function signalsOf(el, fromClues) {
    const s = new Set(fromClues ?? []);
    const t = tokensOf(el);
    if (STRONG_TOKEN_RE.test(t)) s.add("ad_token");
    else if (WEAK_TOKEN_RE.test(t)) s.add("weak_token");
    if (OVERLAY_TOKEN_RE.test(t)) s.add("overlay_token");
    if (ADTECH_ATTRS.some((a) => el.hasAttribute(a))) s.add("adtech_attr");
    return [...s];
  }

  // ---------- description ----------

  function containerOf(el) {
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      const t = cur.localName;
      if (["main", "article", "aside", "nav", "header", "footer"].includes(t)) return t;
    }
    return "body";
  }

  function describe(el, signals) {
    const r = el.getBoundingClientRect();
    const tag = el.localName;
    const e = {
      tag,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      position: getComputedStyle(el).position,
      container: containerOf(el),
      above_fold: r.top < innerHeight && r.bottom > 0,
    };
    if (signals.length) e.signals = signals;
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
    let links = 0;
    let external = 0;
    let sponsoredRel = false;
    for (const a of el.querySelectorAll("a[href]")) {
      links++;
      if (links > 60) continue;
      const h = hostnameOf(a.href);
      if (h && !sameSite(h)) {
        external++;
        if (linkHosts.size < 3) linkHosts.add(h);
      }
      if (/\bsponsored\b/i.test(a.rel)) sponsoredRel = true;
    }
    if (links) e.links = links;
    if (external) e.external_links = external;
    if (linkHosts.size) e.external_hosts = [...linkHosts];
    if (sponsoredRel) e.rel_sponsored = true;
    if (tag !== "iframe") {
      const heading = el.querySelector("h1, h2, h3, h4");
      const headingText = heading && clean(heading.innerText, 100);
      if (headingText) e.heading = headingText;
      const text = clean(el.innerText, 200);
      if (text) e.text = text;
      const imgs = el.querySelectorAll("img, picture, svg").length;
      if (imgs) e.img_count = Math.min(imgs, 20);
      if (el.querySelector("video")) e.has_video = true;
      if (el.querySelector("input, button")) e.has_form_controls = true;
      const closeable = [...el.querySelectorAll('button, [role="button"], a')].slice(0, 12).some((b) => {
        const label = `${b.getAttribute("aria-label") ?? ""} ${b.title ?? ""} ${tokensOf(b)} ${(b.textContent ?? "").trim().slice(0, 12)}`;
        return CLOSE_RE.test(label) || /^[×✕✖x]$/i.test((b.textContent ?? "").trim());
      });
      if (closeable) e.has_close_control = true;
    }
    return e;
  }

  /** Cheap stand-in for a full description: when it hasn't changed, neither has the element. */
  function quickSig(el, r) {
    const frame = el.localName === "iframe" ? el : el.querySelector("iframe");
    return `${Math.round(r.width / 40)}x${Math.round(r.height / 40)}|${el.childElementCount}|${frame?.src.slice(0, 80) ?? ""}|${(el.textContent ?? "").length >> 5}`;
  }

  function fingerprint(e) {
    const [w, h] = e.size.split("x").map((n) => Math.round(Number(n) / 40));
    return hash(
      JSON.stringify([
        e.tag,
        e.iab ?? `${w}x${h}`,
        (e.classes ?? []).map((c) => c.replace(/\d+/g, "#")).sort(),
        e.iframe_host,
        e.external_hosts,
        (e.text ?? "").slice(0, 120).replace(/\d+/g, "#"),
        e.position,
        e.signals,
      ]),
    );
  }

  /** A selector that is stable across loads and matches only a few elements, for pre-paint rules. */
  function stableSelector(el) {
    const tag = el.localName;
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
    // Generated ids like sp_message_container_1515335: the part before the number is stable.
    const prefix = el.id.match(/^([a-z][\w-]*?[_-])\d{3,}$/i)?.[1];
    if (prefix && prefix.length >= 6) {
      const s = tryIt(`${tag}[id^="${CSS.escape(prefix)}"]`);
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
    const before = el.getBoundingClientRect();
    const wasFixed = isFixed(el);
    el.setAttribute("data-jevblock", "hidden");
    el.setAttribute("data-jevblock-label", label ?? "");
    hidden.set(el, label);
    if (wasFixed && isScrollLocked()) document.documentElement.setAttribute("data-jevblock-unlock", "");
    collapseEmptyWrappers(el, label, before);
  }

  /** Scroll locks: overflow hidden, or (common on iOS, where that alone doesn't stop scrolling) a fixed body. */
  function isScrollLocked() {
    const html = getComputedStyle(document.documentElement);
    const body = document.body && getComputedStyle(document.body);
    return html.overflow === "hidden" || body?.overflow === "hidden" || body?.position === "fixed";
  }

  /** Ad slots often sit in wrappers with a reserved height; hide wrappers left with nothing to show. */
  function collapseEmptyWrappers(el, label, before) {
    const maxHeight = Math.max(before.height * 1.5, before.height + 100);
    let cur = el.parentElement;
    for (let i = 0; cur && i < 3; i++, cur = cur.parentElement) {
      if (NEVER_BLOCK_TAGS.has(cur.localName) || ["article", "section", "aside", "nav", "header", "footer"].includes(cur.localName)) return;
      const r = cur.getBoundingClientRect();
      if (r.height > maxHeight || r.width > innerWidth + 1) return;
      if ((cur.innerText ?? "").trim().length > 30) return; // more than an "Advertisement" label left
      const showsSomething = [...cur.querySelectorAll("img, picture, video, iframe, svg, canvas, a, button, input, select")].some((n) => {
        if (n.closest('[data-jevblock="hidden"]')) return false;
        const nr = n.getBoundingClientRect();
        return nr.width > 0 && nr.height > 0;
      });
      if (showsSomething) return;
      cur.setAttribute("data-jevblock", "hidden");
      cur.setAttribute("data-jevblock-label", label ?? "");
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

  function ruleHidesSomething() {
    return state.rules.some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch {
        return false;
      }
    });
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
  let scanDue = 0;
  let scanning = false;

  /** Never pushes back a scan that is already due sooner, so busy pages still get scanned. */
  function scheduleScan(delay = RESCAN_MS) {
    if (!state.active || state.scans >= MAX_SCANS || state.asked >= MAX_PER_PAGE) return;
    const due = Date.now() + delay;
    if (scanTimer && scanDue <= due) return;
    clearTimeout(scanTimer);
    scanDue = due;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  /** Blocks plus clue elements, minus what is hidden, off-screen, unchanged since asked, or private. */
  function collect() {
    const bySignal = clues();
    const els = new Set(segment());
    for (const [el, signals] of bySignal) {
      const r = el.getBoundingClientRect();
      if (!blockSized(r) || (!isFixed(el) && (!inRange(r) || r.height > Math.max(1600, innerHeight * 2.5)))) continue;
      els.add(el);
    }
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const sig = quickSig(el, r);
      const prev = checked.get(el);
      if (prev && (prev.sig === sig || prev.n >= MAX_CHECKS)) continue;
      if (neverAsk(el)) continue;
      const entry = describe(el, signalsOf(el, bySignal.get(el)));
      const fp = fingerprint(entry);
      if (prev?.fp === fp) {
        prev.sig = sig;
        continue;
      }
      out.push({ el, entry, fp, sig, top: r.top });
    }
    // Nearest to what the reader sees first.
    out.sort((a, b) => Math.abs(a.top) - Math.abs(b.top));
    return out.slice(0, Math.min(MAX_PER_SCAN, MAX_PER_PAGE - state.asked));
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
      mark("firstScan");
      // A consent wall hidden by a learned rule leaves the page scroll-locked just like one hidden here.
      if (!document.documentElement.hasAttribute("data-jevblock-unlock") && state.rules.length && isScrollLocked() && ruleHidesSomething()) {
        document.documentElement.setAttribute("data-jevblock-unlock", "");
      }
      const started = performance.now();
      const found = collect();
      state.scanMs = Math.round(performance.now() - started);
      state.maxScanMs = Math.max(state.maxScanMs, state.scanMs);
      debugOut();
      if (!found.length) return;
      const byFp = new Map();
      const candidates = [];
      for (const { el, entry, fp, sig } of found) {
        checked.set(el, { fp, sig, n: (checked.get(el)?.n ?? 0) + 1 });
        if (!byFp.has(fp)) {
          byFp.set(fp, []);
          const sel = stableSelector(el);
          candidates.push(sel ? { fp, sel, entry } : { fp, entry });
        }
        byFp.get(fp).push(el);
      }
      state.asked += found.length;
      const page = { host, title: clean(document.title, 120), lang: document.documentElement.lang?.slice(0, 8) || undefined };
      const apply = (verdicts) => {
        for (const v of verdicts ?? []) {
          for (const el of byFp.get(v.fp) ?? []) {
            if (v.hide) hide(el, v.label);
            // Debug setting: tag every checked element with its verdict, for inspecting misses.
            if (state.debug) el.setAttribute("data-jevblock-seen", `${v.label} ${v.p}`);
          }
        }
        if (hidden.size) mark("firstHide");
        debugOut();
      };
      mark("firstRequest");
      // Remembered verdicts come back without waiting for Jev.
      const known = await send({ type: "classify", host, page, candidates, cachedOnly: true });
      apply(known?.verdicts);
      const missing = new Set(known?.misses ?? candidates.map((c) => c.fp));
      const misses = candidates.filter((c) => missing.has(c.fp));
      // The rest in Jev-sized chunks, nearest to the viewport first, each hidden as soon as it's back
      // instead of waiting for the slowest one.
      const chunks = [];
      for (let i = 0; i < misses.length; i += CHUNK) chunks.push(misses.slice(i, i + CHUNK));
      // Not awaited: the next scan can start while Jev is still answering (elements are already
      // marked as checked, so nothing is asked twice).
      state.error = null;
      Promise.all(
        chunks.map(async (chunk) => {
          const res = await send({ type: "classify", host, page, candidates: chunk });
          if (res?.error) state.error = res.error;
          state.tokens += res?.tokens ?? 0;
          apply(res?.verdicts);
        }),
      ).then(() => send({ type: "badge", count: hiddenCount() }));
    } finally {
      scanning = false;
    }
  }

  /** Added nodes that look like an overlay or ad (consent walls, popups, ad frames) get a quick rescan. */
  function looksUrgent(node) {
    if (node.localName === "iframe") return true;
    const t = tokensOf(node);
    return OVERLAY_TOKEN_RE.test(t) || STRONG_TOKEN_RE.test(t) || isFixed(node);
  }

  function start() {
    scheduleScan(0);
    addEventListener("load", () => scheduleScan(400), { once: true });
    addEventListener("scroll", () => scheduleScan(500), { passive: true });
    new MutationObserver((records) => {
      let added = 0;
      let urgent = false;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          if (!urgent && ++added <= 40) urgent = looksUrgent(n);
          else added++;
        }
      }
      if (added) scheduleScan(urgent ? 100 : RESCAN_MS);
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
        scans: state.scans,
        scanMs: state.scanMs,
        maxScanMs: state.maxScanMs,
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

  // Paused state and learned rules are read straight from storage: no waiting for the background
  // worker, which may be starting cold. It is woken in parallel so it can open the connection to Jev.
  const RULE_MIN_HITS = 2; // same as background.js

  async function initFromStorage() {
    const key = "site:" + host;
    const { settings, [key]: site } = await api.storage.local.get(["settings", key]);
    if (!settings?.categories) return send({ type: "init", host }); // defaults live in the worker
    if ((settings.pausedHosts ?? []).some((h) => host === h || host.endsWith("." + h))) return { active: false };
    const inUse = settings.categories.filter((c) => c.enabled !== false); // as in background.js
    const version = hash(JSON.stringify(inUse.map((c) => [c.id, c.description])));
    const hiddenLabels = new Set(inUse.filter((c) => c.hide).map((c) => c.id));
    const rules = site?.v === version
      ? Object.entries(site.rules ?? {}).filter(([, r]) => r.hits >= RULE_MIN_HITS && hiddenLabels.has(r.label)).map(([sel]) => sel)
      : [];
    return { active: true, rules, extraSelectors: settings.extraSelectors ?? "", debug: !!settings.debug };
  }

  send({ type: "warm" });
  initFromStorage()
    .catch(() => send({ type: "init", host }))
    .then((res) => {
      if (res?.error) {
        state.error = res.error;
        return;
      }
      if (!res?.active) {
        state.paused = true;
        return;
      }
      state.active = true;
      state.debug = !!res.debug;
      state.extra = (res.extraSelectors ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      applyRules(res.rules ?? []);
      mark("rules");
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
      else start();
    });
})();
