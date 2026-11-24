import { accessSettings, fileAccess, fileUrl, isOrdinaryPage, siteAccess, siteKey, webUrl } from "./sites.mjs";

function matches(tab, text) {
  if (tab.url === text) return true;
  // A document title such as "PDF: Chapter 1" is also a valid URL scheme prefix.
  if (!/^(?:[a-z][a-z\d+.-]*:\/\/|about:|blob:|data:|devtools:|javascript:|view-source:)/i.test(text)) return tab.title === text;
  if (!tab.url) return false;
  return tab.url === webUrl(text)?.href || (/^chrome:\/\/[\w-]+$/i.test(text) && tab.url === text + "/");
}

async function route(api, tab, settings, selected) {
  const url = webUrl(tab.url);
  const file = fileUrl(tab.url);
  if (file) {
    if (!await fileAccess(api)) return "file-permission";
  } else {
    if (!isOrdinaryPage(url)) return "browser-ui";
    if (settings.records[siteKey(url)] === false) return "excluded";
    const access = await siteAccess(api, url, settings);
    if (access === "none") return "site-permission";
    if (access === "current-tab" && !selected) {
      const key = "task:" + tab.id;
      if ((await api.storage.session.get(key))[key] !== url.origin) return "select-or-share";
    }
  }
  return /\.pdf$/i.test((file || url).pathname) ? "pdf-candidate" : "page";
}

export async function locateTabs(api, text) {
  if (text !== undefined && (typeof text !== "string" || !text.trim())) throw new Error("INVALID_TARGET");
  const [current] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  const candidates = text === undefined ? [current] : await api.tabs.query({ windowType: "normal" });
  const named = candidates.filter(tab => tab && !tab.incognito && (text === undefined || matches(tab, text)));
  const settings = await accessSettings(api);
  const tabs = await Promise.all(named.map(async tab => {
    const selected = tab.id === current?.id;
    // A browser-generated title for an inline URL can itself contain the document.
    const inline = /^(data|javascript):/i;
    const url = inline.test(tab.url || "") ? undefined : tab.url;
    const title = inline.test(tab.title || "") ? undefined : tab.title;
    return { id: tab.id, windowId: tab.windowId, title, url, selected,
      route: await route(api, tab, settings, selected) };
  }));
  return { tabs };
}

export async function focusTab(api, tabId, expected) {
  if (!Number.isInteger(tabId) || tabId < 0 || typeof expected !== "string" || !expected.trim()) throw new Error("INVALID_TARGET");
  const tab = await api.tabs.get(tabId);
  if (!tab || tab.incognito || tab.pendingUrl || !matches(tab, expected)) throw new Error("TARGET_CHANGED");
  await api.tabs.update(tabId, { active: true });
  await api.windows.update(tab.windowId, { focused: true });
  const [current] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (current?.id !== tabId || current.pendingUrl || !matches(current, expected)) throw new Error("TARGET_CHANGED");
  return { tabId, selected: true };
}
