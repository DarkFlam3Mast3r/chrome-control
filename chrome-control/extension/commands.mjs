import { accessSettings, hostPattern, isOrdinaryPage, sharedSites, siteAccess, siteKey, webUrl } from "./sites.mjs";
import { runOnPage } from "./page.mjs";
import { captureViewport } from "./screenshot.mjs";

const taskPageActions = new Set(["read", "controls", "wait", "select-text"]);
const actions = new Set([...taskPageActions, "click", "fill", "check", "select", "scroll", "screenshot"]);
export const taskKey = tabId => "task:" + tabId;

async function currentTab(api) {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export async function forgetOtherOrigin(api, tabId, href) {
  const key = taskKey(tabId);
  const origin = (await api.storage.session.get(key))[key];
  if (origin && origin !== webUrl(href)?.origin) await api.storage.session.remove(key);
}

async function listTabs(api) {
  const settings = await accessSettings(api);
  const allowed = new Set();
  for (const site of sharedSites(settings.records)) {
    if (await api.permissions.contains({ origins: [hostPattern(site)] })) allowed.add(site.origin);
  }
  const tasks = settings.allSites ? await api.storage.session.get(null) : {};
  const origins = [...allowed, ...Object.values(tasks)];
  const patterns = [...new Set(origins.map(origin => hostPattern(new URL(origin))))];
  const candidates = patterns.length ? await api.tabs.query({ url: patterns }) : [];
  const tabs = candidates.filter(tab => {
    const u = webUrl(tab.url);
    return !tab.incognito && isOrdinaryPage(u) && settings.records[siteKey(u)] !== false &&
      (allowed.has(u.origin) || tasks[taskKey(tab.id)] === u.origin);
  });
  if (settings.allSites) {
    const tab = await currentTab(api);
    if (tab && !tab.incognito && !tabs.some(t => t.id === tab.id) &&
        await siteAccess(api, webUrl(tab.url), settings) !== "none") tabs.push(tab);
  }
  return { tabs: tabs.map(({ id, title, url, active }) => ({ id, title, url, active })) };
}

async function openTab(api, command) {
  const url = webUrl(command.url);
  if (!url) throw new Error("WEB_URL_REQUIRED");
  const access = await siteAccess(api, url, await accessSettings(api, [siteKey(url)]));
  const focus = command.action === "open" && command.focus === true;
  const siteShared = access !== "none";
  if (siteShared) {
    const sameHost = await api.tabs.query({ url: [hostPattern(url)] });
    const exact = sameHost.filter(t => !t.incognito && !t.pendingUrl && webUrl(t.url)?.href === url.href);
    const current = await currentTab(api);
    let existing = exact.find(t => t.id === current?.id);
    if (!existing && (focus || access === "site")) existing = exact[0];
    if (!existing && exact.length) {
      const tasks = await api.storage.session.get(null);
      existing = exact.find(t => tasks[taskKey(t.id)] === url.origin);
    }
    if (existing) {
      if (focus && existing.id !== current?.id) {
        await api.tabs.update(existing.id, { active: true });
        await api.windows.update(existing.windowId, { focused: true });
      }
      return { tabId: existing.id, requestedUrl: url.href, siteShared, reused: true };
    }
  }
  const create = { url: url.href, active: focus };
  if (!focus) {
    // An explicit existing window also prevents Chrome from creating its first window in the foreground.
    const normal = { active: true, windowType: "normal" };
    let [host] = await api.tabs.query({ ...normal, lastFocusedWindow: true });
    if (!host || host.incognito) host = (await api.tabs.query(normal)).find(t => !t.incognito);
    if (!host) throw new Error("NO_BACKGROUND_WINDOW");
    create.windowId = host.windowId;
  }
  const tab = await api.tabs.create(create);
  if (!focus && access === "current-tab" && !tab.incognito) {
    await api.storage.session.set({ [taskKey(tab.id)]: url.origin });
  }
  return { tabId: tab.id, requestedUrl: url.href, siteShared, reused: false };
}

async function runOnce(api, command) {
  const tab = await api.tabs.get(command.tabId);
  if (!tab) throw new Error("INVALID_TAB");
  if (tab.status === "loading" || (tab.pendingUrl && tab.pendingUrl !== tab.url)) throw new Error("PAGE_LOADING");
  const url = webUrl(tab.url);
  if (tab.incognito || !isOrdinaryPage(url)) throw new Error("SITE_NOT_SHARED");
  const access = await siteAccess(api, url, await accessSettings(api, [siteKey(url)]));
  if (access === "none") throw new Error("SITE_NOT_SHARED");
  if (command.action === "screenshot") return captureViewport(api, tab);
  let currentOnly = access === "current-tab";
  if (currentOnly && taskPageActions.has(command.action)) {
    const key = taskKey(tab.id);
    currentOnly = (await api.storage.session.get(key))[key] !== url.origin;
  }
  if (currentOnly && (await currentTab(api))?.id !== tab.id) throw new Error("TAB_NOT_CURRENT");
  const target = command.documentId ? { tabId: tab.id, documentIds: [command.documentId] } : { tabId: tab.id, frameIds: [0] };
  const [frame] = await api.scripting.executeScript({
    target, world: "ISOLATED", func: runOnPage, args: [command, url.href, currentOnly]
  });
  if (!frame || frame.frameId !== 0 || !frame.result) throw new Error("NO_PAGE_RESULT");
  if (frame.result.error) throw new Error(frame.result.error);
  return { ...frame.result, documentId: frame.documentId };
}

async function waitForPage(api, command) {
  const timeout = command.timeoutMs ?? 8000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 10000) throw new Error("INVALID_TIMEOUT");
  if (!["ready", "text", "gone"].includes(command.condition)) throw new Error("INVALID_CONDITION");
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const result = await runOnce(api, command);
      if (result.matched) return result;
    } catch (error) {
      if (!["PAGE_LOADING", "PAGE_CHANGED"].includes(error.message) &&
          !/^(?:Frame with ID 0 was removed|The frame was removed)\.?$/i.test(error.message)) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("WAIT_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
  }
}

export async function dispatch(api, command) {
  const { action } = command;
  if (action === "status") {
    const { allSites } = await accessSettings(api, []);
    return { browser: "Chrome", version: api.runtime.getManifest().version, connected: true, allSites };
  }
  if (action === "tabs") return listTabs(api);
  // Older workers reject open-background; a new CLI cannot silently activate a tab through an old worker.
  if (action === "open" || action === "open-background") return openTab(api, command);
  if (!actions.has(action)) throw new Error("UNKNOWN_ACTION");
  if (!Number.isInteger(command.tabId) || command.tabId < 0) throw new Error("INVALID_TAB");
  if (!Number.isSafeInteger(command.offset ?? 0) || (command.offset ?? 0) < 0) throw new Error("INVALID_OFFSET");
  if (["fill", "check", "select", "select-text"].includes(action) || (action === "wait" && command.condition !== "ready")) {
    if (typeof command.value !== "string" || command.value.length > 16000 ||
        (["select-text", "wait"].includes(action) && !command.value.trim())) throw new Error("INVALID_VALUE");
  }
  if (action === "select-text" && command.occurrence !== undefined &&
      (!Number.isSafeInteger(command.occurrence) || command.occurrence < 1)) throw new Error("INVALID_OCCURRENCE");
  if (action === "scroll" && !["up", "down"].includes(command.direction)) throw new Error("INVALID_DIRECTION");
  return action === "wait" ? waitForPage(api, command) : runOnce(api, command);
}
