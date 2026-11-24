// Chrome serializes this function into the extension's isolated world.
export function runOnPage(command, expectedUrl, currentOnly = false) {
  if (window !== window.top || location.href !== expectedUrl) return { error: "PAGE_CHANGED" };
  if (currentOnly && document.visibilityState !== "visible") return { error: "TAB_NOT_CURRENT" };

  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length ||
        el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
  }

  const { action, ref, value, offset = 0 } = command;
  const controlSelector = "a[href],button,input,textarea,select,summary,[role='button'],[role='link']," +
    "[role='checkbox'],[role='tab'],[role='switch'],[contenteditable]:not([contenteditable='false'])";
  if (action === "wait") {
    const condition = command.condition;
    const ready = document.readyState !== "loading";
    const found = ready && condition !== "ready" && ((visible(document.body) && document.body.innerText.includes(value)) ||
      [...document.querySelectorAll(controlSelector)].some(el => eligible(el) && label(el).includes(value)));
    return { matched: ready && (condition === "ready" || (condition === "text" ? found : !found)),
      condition, url: location.href };
  }
  if (action === "read" || action === "select-text") {
    const selectors = ["#js_content", "article", "main", "[role='main']", "body"];
    let source, root, text = "";
    for (source of selectors) {
      for (const block of document.querySelectorAll(source)) {
        if (!visible(block)) continue;
        const candidate = block.innerText?.trim() || "";
        if (candidate.length > text.length) { text = candidate; root = block; }
      }
      if (text) break;
    }
    if (action === "select-text") return selectText(root);
    const end = Math.min(offset + 12000, text.length);
    return { title: document.title, url: location.href, source, text: text.slice(offset, end),
      offset, total: text.length, nextOffset: end < text.length ? end : null };
  }

  function selectText(root) {
    const words = value.trim().split(/\s+/u);
    if (!root || !words[0]) return { error: "TEXT_NOT_FOUND" };
    const escape = word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(words.map(escape).join("\\s+"), "gu");
    const blocks = "article,main,section,div,p,li,dd,dt,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,pre";
    const skip = "script,style,noscript,textarea,input,select,button,[contenteditable]:not([contenteditable='false'])";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let parts = [], length = 0, block, matches = 0, target;
    function searchRun() {
      if (!parts.length) return;
      const raw = parts.map(part => part.node.data).join("");
      for (const match of raw.matchAll(pattern)) {
        if (++matches !== (command.occurrence ?? 1)) continue;
        const end = match.index + match[0].length;
        const first = parts.find(part => part.end > match.index);
        const last = parts.find(part => part.end >= end);
        target = document.createRange();
        target.setStart(first.node, first.node.length - (first.end - match.index));
        target.setEnd(last.node, last.node.length - (last.end - end));
      }
      parts = [];
      length = 0;
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.localName === "br") searchRun();
        continue;
      }
      const parent = node.parentElement;
      const nextBlock = parent.closest(blocks);
      if (block !== nextBlock) { searchRun(); block = nextBlock; }
      if (parent.closest(skip) || !visible(parent)) { searchRun(); continue; }
      if (node.length) {
        length += node.length;
        parts.push({ node, end: length });
      }
    }
    searchRun();
    if (!target) return { error: "TEXT_NOT_FOUND" };
    if (matches > 1 && command.occurrence === undefined) return { error: "TEXT_NOT_UNIQUE" };
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(target);
    const selected = selection.toString();
    if (selected.trim().replace(/\s+/gu, " ") !== words.join(" ")) return { error: "SELECTION_CHANGED" };
    return { text: selected, occurrence: command.occurrence ?? 1, matches, url: location.href };
  }
  if (action === "scroll") {
    const before = window.scrollY;
    window.scrollBy({ top: (command.direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
    return { before, after: window.scrollY };
  }

  function eligible(el) {
    return visible(el) && !el.matches(":disabled, [aria-disabled='true'], [readonly]") &&
      !el.matches("input[type='hidden'], input[type='password'], input[type='file']") &&
      !/(?:^|\s)(?:current-password|new-password|one-time-code|cc-\S+)(?:\s|$)/i.test(el.autocomplete || "");
  }
  function label(el) {
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
    const labels = el.labels ? [...el.labels].map(item => item.innerText || "").join(" ") : "";
    const buttonText = el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type) ? el.value : "";
    const inner = ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable ? "" : el.innerText;
    return (labelledBy || el.getAttribute("aria-label") || labels || buttonText || inner ||
      el.getAttribute("placeholder") || el.title || el.name || "").replace(/\s+/g, " ").trim().slice(0, 180);
  }
  function identity(el) {
    return JSON.stringify([el.tagName, el.type, el.getAttribute("role"), label(el), el.name,
      el.href || "", el.getAttribute("formaction"), el.form?.action || "", el.form?.method || ""]);
  }
  if (action === "controls") {
    const items = [...document.querySelectorAll(controlSelector)].filter(eligible);
    const token = [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16)).join("-");
    const entries = new Map();
    const controls = items.slice(offset, offset + 45).map((el, i) => {
      const ref = token + "." + (offset + i);
      entries.set(ref, { el, identity: identity(el) });
      const control = { ref, role: el.getAttribute("role") || el.localName, label: label(el) };
      if (el.tagName === "INPUT") control.type = el.type;
      if (["checkbox", "radio"].includes(el.type)) control.checked = el.checked;
      if (el.tagName === "SELECT") {
        control.options = [...el.options].slice(0, 25).map(o => o.label.slice(0, 110));
        control.optionCount = el.options.length;
        control.selected = el.selectedOptions[0]?.label.slice(0, 110) || "";
      }
      return control;
    });
    globalThis.__codexChromeControls = { url: location.href, entries };
    return { title: document.title, url: location.href, controls, total: items.length,
      nextOffset: offset + controls.length < items.length ? offset + controls.length : null };
  }

  const snapshot = globalThis.__codexChromeControls;
  const entry = snapshot?.entries.get(ref);
  if (!entry || snapshot.url !== location.href || !eligible(entry.el) ||
      identity(entry.el) !== entry.identity) return { error: "STALE_REF" };
  const el = entry.el;
  if (action !== "check" && typeof document.elementFromPoint === "function") {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const box = el.getBoundingClientRect();
    const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
    const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (!el.contains(hit) && ![...(el.labels || [])].some(label => label.contains(hit)))) {
      return { error: "CONTROL_COVERED" };
    }
  }
  if (action === "click") {
    el.click();
    return { dispatched: true };
  }
  if (action === "select") {
    if (el.tagName !== "SELECT" || el.multiple) return { error: "EXPECTED_SINGLE_SELECT" };
    const options = [...el.options].filter(o => !o.disabled && !o.parentElement?.disabled &&
      (o.label === value || o.value === value));
    if (options.length !== 1) return { error: "OPTION_NOT_UNIQUE" };
    el.selectedIndex = options[0].index;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { matched: el.selectedOptions[0] === options[0] };
  }
  if (action !== "fill" && action !== "check") return { error: "UNKNOWN_ACTION" };
  const isInput = el.tagName === "INPUT" && ["text", "search", "url", "email", "tel", "number"].includes(el.type);
  if (!isInput && el.tagName !== "TEXTAREA" && !el.isContentEditable) return { error: "EXPECTED_TEXT_FIELD" };
  if (action === "check") return { matched: (el.isContentEditable ? el.innerText : el.value) === value };
  el.focus();
  if (!eligible(el) || identity(el) !== entry.identity) return { error: "STALE_REF" };
  if (el.isContentEditable) el.innerText = value;
  else {
    const proto = isInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { matched: el.isConnected && (el.isContentEditable ? el.innerText : el.value) === value };
}
