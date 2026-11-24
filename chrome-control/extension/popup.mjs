import { accessSettings, allWebOrigins, hostPattern, isOrdinaryPage, sharedSites, siteAccess, siteKey, webUrl } from "./sites.mjs";

const byId = id => document.getElementById(id);
const toggle = byId("toggle");
const allSitesToggle = byId("all-sites");
let site, enabled, allSites;

async function refreshSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = webUrl(tab?.url);
  const settings = await accessSettings(chrome, site ? [siteKey(site)] : []);
  allSites = settings.allSites;
  allSitesToggle.checked = allSites;
  allSitesToggle.disabled = false;
  if (!isOrdinaryPage(site) || tab?.incognito) {
    byId("origin").textContent = "请在普通 HTTP 或 HTTPS 网页打开扩展。";
    byId("scope").textContent = "";
    toggle.disabled = true;
    return;
  }
  byId("origin").textContent = site.origin;
  enabled = await siteAccess(chrome, site, settings) !== "none";
  if (allSites) {
    byId("scope").textContent = enabled ? "此网站已允许。" : "此网站已排除。";
    toggle.textContent = enabled ? "排除此网站" : "恢复此网站";
  } else {
    byId("scope").textContent = enabled ? "已允许。下次访问时继续生效。" : "允许后，本机 Codex 可以读取和操作这个网站的网页。";
    toggle.textContent = enabled ? "撤销此网站" : "允许此网站";
  }
  toggle.disabled = false;
}

toggle.onclick = async () => {
  allSitesToggle.disabled = toggle.disabled = true;
  const origins = [hostPattern(site)];
  try {
    if (allSites) {
      if (enabled) await chrome.storage.local.set({ [siteKey(site)]: false });
      else await chrome.storage.local.remove(siteKey(site));
    } else if (enabled) {
      await chrome.storage.local.set({ [siteKey(site)]: false });
      const remaining = sharedSites(await chrome.storage.local.get(null));
      if (!remaining.some(url => hostPattern(url) === origins[0])) await chrome.permissions.remove({ origins });
    } else if (await chrome.permissions.request({ origins })) {
      // Chrome host permissions can span ports. Store the exact origin the user saw.
      await chrome.storage.local.set({ [siteKey(site)]: true });
    }
    await refreshSite();
  } catch (error) {
    await refreshSite();
    byId("scope").textContent = error.message;
  }
};

allSitesToggle.onchange = async () => {
  const enable = allSitesToggle.checked;
  allSitesToggle.disabled = toggle.disabled = true;
  try {
    if (enable) {
      // Initiate both from the click handler. Chrome may close the popup while
      // showing consent. The worker always checks the actual grant as well.
      const saveChoice = chrome.storage.local.set({ allSites: true });
      const request = chrome.permissions.request({ origins: allWebOrigins });
      const [, accepted] = await Promise.all([saveChoice, request]);
      if (!accepted) await chrome.storage.local.remove("allSites");
    } else {
      const [, removed] = await Promise.all([
        chrome.storage.local.remove("allSites"), chrome.permissions.remove({ origins: allWebOrigins })
      ]);
      if (!removed && await chrome.permissions.contains({ origins: allWebOrigins })) {
        throw new Error("全站模式已关闭。Chrome 仍保留网站权限，可在扩展详情中管理。");
      }
    }
    await refreshSite();
  } catch (error) {
    if (enable) await chrome.storage.local.remove("allSites");
    await refreshSite();
    byId("scope").textContent = error.message;
  }
};

async function refreshConnection() {
  byId("retry").hidden = true;
  let result;
  try { result = await chrome.runtime.sendMessage({ action: "connection" }); }
  catch (error) { result = { detail: error.message }; }
  byId("connection").textContent = result?.ready ? "本机连接已就绪" : "本机连接未就绪 · " + (result?.detail || "请重试");
  byId("retry").hidden = Boolean(result?.ready);
}
byId("retry").onclick = refreshConnection;
refreshSite().catch(error => { byId("origin").textContent = error.message; });
refreshConnection();
