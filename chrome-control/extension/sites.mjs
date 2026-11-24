export const allWebOrigins = ["http://*/*", "https://*/*"];

export function webUrl(value) {
  try {
    const u = new URL(value);
    if (["http:", "https:"].includes(u.protocol) && !u.username && !u.password) return u;
  } catch { /* Blank and protected tabs may have no usable URL. */ }
  return null;
}

export function isOrdinaryPage(url) {
  return Boolean(url && url.hostname !== "chromewebstore.google.com" &&
    !(url.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(url.pathname)));
}

export function hostPattern(url) {
  return url.protocol + "//" + url.hostname + "/*";
}

export function siteKey(url) {
  return "site:" + url.origin;
}

export async function accessSettings(api, keys = null) {
  const records = await api.storage.local.get(keys === null ? null : ["allSites", ...keys]);
  const allSites = records.allSites === true && await api.permissions.contains({ origins: allWebOrigins });
  return { records, allSites };
}

export async function siteAccess(api, url, settings) {
  if (!isOrdinaryPage(url)) return "none";
  const choice = settings.records[siteKey(url)];
  if (choice === false || (choice !== true && !settings.allSites)) return "none";
  if (!await api.permissions.contains({ origins: [hostPattern(url)] })) return "none";
  return choice === true ? "site" : "current-tab";
}

export function sharedSites(records) {
  const sites = Object.keys(records).filter(key => key.startsWith("site:") && records[key] === true);
  return sites.map(key => webUrl(key.slice(5))).filter(Boolean);
}
