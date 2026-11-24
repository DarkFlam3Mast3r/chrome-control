import { accessSettings, fileAccess, fileUrl, siteAccess, siteKey, webUrl } from "./sites.mjs";

export async function captureViewport(api, tab) {
  let changed = false;
  const activation = info => { if (info.windowId === tab.windowId && info.tabId !== tab.id) changed = true; };
  const focus = windowId => { if (windowId !== tab.windowId) changed = true; };
  const navigation = (id, info) => { if (id === tab.id && (info.url || info.status === "loading")) changed = true; };
  async function stillSelected() {
    const [current] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    return current?.id === tab.id && !current.incognito && current.url === tab.url &&
      !current.pendingUrl && current.status !== "loading";
  }
  api.tabs.onActivated.addListener(activation);
  api.windows.onFocusChanged.addListener(focus);
  api.tabs.onUpdated.addListener(navigation);
  try {
    if (!await stillSelected()) throw new Error("SCREENSHOT_TAB_NOT_VISIBLE");
    let png;
    try { png = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" }); }
    catch (error) {
      if (/activeTab|all_urls|permission|grant/i.test(error.message)) throw new Error("SCREENSHOT_PERMISSION_REQUIRED");
      throw error;
    }
    const url = webUrl(tab.url);
    const allowed = fileUrl(tab.url) ? await fileAccess(api) :
      url && await siteAccess(api, url, await accessSettings(api, [siteKey(url)])) !== "none";
    if (!allowed || !await stillSelected() || changed) throw new Error("SCREENSHOT_TARGET_CHANGED");
    if (!png?.startsWith("data:image/png;base64,")) throw new Error("CAPTURE_FAILED");
    if (png.length > 24 * 1024 * 1024) throw new Error("SCREENSHOT_TOO_LARGE");
    return { url: tab.url, png };
  } finally {
    api.tabs.onActivated.removeListener(activation);
    api.windows.onFocusChanged.removeListener(focus);
    api.tabs.onUpdated.removeListener(navigation);
  }
}
