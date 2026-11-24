import { accessSettings, allWebOrigins, fileAccess, fileUrl, hostPattern, isOrdinaryPage, siteAccess, siteKey, webUrl } from "./sites.mjs";

const byId = id => document.getElementById(id);
const toggle = byId("toggle");
const allSitesToggle = byId("all-sites");
let site, enabled, allSites, webGranted, siteGranted;

async function refreshSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = webUrl(tab?.url);
  byId("file-issue").hidden = !fileUrl(tab?.url) || tab.incognito || await fileAccess(chrome);
  const [settings, broadGrant] = await Promise.all([
    accessSettings(chrome, site ? [siteKey(site)] : []),
    chrome.permissions.contains({ origins: allWebOrigins })
  ]);
  webGranted = broadGrant;
  allSites = settings.allSites;
  allSitesToggle.checked = allSites;
  allSitesToggle.disabled = false;
  const canManageSite = isOrdinaryPage(site) && !tab.incognito;
  byId("site-access").hidden = !canManageSite;
  byId("origin").textContent = canManageSite ? site.origin : "";
  byId("scope").textContent = "";
  if (!canManageSite) {
    toggle.disabled = true;
    return;
  }
  siteGranted = webGranted || await chrome.permissions.contains({ origins: [hostPattern(site)] });
  enabled = await siteAccess(chrome, site, settings) !== "none";
  toggle.setAttribute("aria-checked", String(enabled));
  toggle.title = enabled ? (allSites ? "排除此网站" : "撤销此网站") : "允许此网站";
  toggle.disabled = false;
}

toggle.onclick = async () => {
  allSitesToggle.disabled = toggle.disabled = true;
  const origins = [hostPattern(site)];
  let declined = false;
  try {
    if (allSites) {
      if (enabled) await chrome.storage.local.set({ [siteKey(site)]: false });
      else await chrome.storage.local.remove(siteKey(site));
    } else if (enabled) {
      await chrome.storage.local.set({ [siteKey(site)]: false });
    } else if (siteGranted || await chrome.permissions.request({ origins })) {
      // Chrome host permissions can span ports. Store the exact origin the user saw.
      await chrome.storage.local.set({ [siteKey(site)]: true });
    } else { declined = true; }
    await refreshSite();
    if (declined) byId("scope").textContent = "未授予此网站权限";
  } catch (error) {
    await refreshSite();
    byId("scope").textContent = error.message;
  }
};

allSitesToggle.onchange = async () => {
  const enable = allSitesToggle.checked;
  let declined = false;
  allSitesToggle.disabled = toggle.disabled = true;
  try {
    if (enable) {
      // Initiate both from the click handler. Chrome may close the popup while
      // showing consent. The worker always checks the actual grant as well.
      const saveChoice = chrome.storage.local.set({ allSites: true });
      const request = webGranted || chrome.permissions.request({ origins: allWebOrigins });
      const [, accepted] = await Promise.all([saveChoice, request]);
      if (!accepted) { declined = true; await chrome.storage.local.remove("allSites"); }
    } else {
      await chrome.storage.local.set({ allSites: false });
    }
    await refreshSite();
    if (declined) byId("scope").textContent = "未开启全站访问";
  } catch (error) {
    if (enable) await chrome.storage.local.remove("allSites");
    await refreshSite();
    byId("scope").textContent = error.message;
  }
};

async function refreshConnection() {
  const status = byId("connection");
  status.dataset.state = "pending";
  status.textContent = "连接中";
  byId("connection-issue").hidden = true;
  byId("retry").hidden = true;
  let result;
  try { result = await chrome.runtime.sendMessage({ action: "connection" }); }
  catch (error) { result = { detail: error.message }; }
  status.dataset.state = result?.ready ? "ready" : "offline";
  status.textContent = result?.ready ? "已连接" : "未连接";
  byId("connection-issue").hidden = Boolean(result?.ready);
  byId("connection-detail").textContent = result?.ready ? "" : (result?.detail || "请检查本机程序");
  byId("retry").hidden = Boolean(result?.ready);
}
byId("retry").onclick = refreshConnection;

byId("file-settings").onclick = () => chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id });
refreshSite().catch(error => { byId("scope").textContent = error.message; });
refreshConnection();
