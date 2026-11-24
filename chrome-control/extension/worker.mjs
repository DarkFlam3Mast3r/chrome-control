import { dispatch, forgetOtherOrigin, taskKey } from "./commands.mjs";
import { accessSettings, hostPattern, sharedSites, siteKey } from "./sites.mjs";

let port;
let ready = false;
let detail = "";
let connecting;

function state() {
  return { ready, detail };
}

function connect() {
  if (port) return connecting || Promise.resolve(state());
  detail = "";
  let finish;
  connecting = new Promise(resolve => { finish = resolve; });
  const attempt = connecting;
  try {
    const current = chrome.runtime.connectNative("local.codex.chrome_control");
    port = current;
    current.onMessage.addListener(async message => {
      if (message.type === "ready") {
        ready = true;
        finish(state());
        return;
      }
      if (message.type === "error") {
        detail = message.error;
        finish(state());
        return;
      }
      if (!ready || typeof message.id !== "string" || !message.command) return;
      let reply;
      try {
        reply = { ok: true, data: await dispatch(chrome, message.command) };
      } catch (error) {
        reply = { ok: false, error: error.message };
      }
      // A disconnected port cannot acknowledge an action. Never replay it.
      if (port === current) {
        try { current.postMessage({ id: message.id, reply }); } catch { /* Already closed. */ }
      }
    });
    current.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message;
      const wasReady = ready;
      ready = false;
      detail ||= reason || "本机连接已关闭";
      port = connecting = undefined;
      finish(state());
      // Recover once from an established host that exited. A missing host or a
      // second profile waits for an explicit retry instead of a restart loop.
      if (wasReady) setTimeout(connect, 1000);
    });
  } catch (error) {
    detail = error.message;
    port = connecting = undefined;
    finish(state());
  }
  return attempt;
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.tabs.onRemoved.addListener(id => chrome.storage.session.remove(taskKey(id)));
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.storage.session.remove(taskKey(tabId)));
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.url) return forgetOtherOrigin(chrome, id, info.url);
});
chrome.permissions.onRemoved.addListener(async removed => {
  if (!removed.origins?.length) return;
  const settings = await accessSettings(chrome);
  if (settings.records.allSites === true && !settings.allSites) await chrome.storage.local.remove("allSites");
  for (const url of sharedSites(settings.records)) {
    if (!await chrome.permissions.contains({ origins: [hostPattern(url)] })) {
      await chrome.storage.local.remove(siteKey(url));
    }
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL("popup.html") || message?.action !== "connection") return;
  if (ready) { respond(state()); return; }
  connect().then(respond);
  return true;
});
