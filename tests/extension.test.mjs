import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";
import { dispatch } from "../chrome-control/extension/commands.mjs";
import { runOnPage } from "../chrome-control/extension/page.mjs";
import { accessSettings } from "../chrome-control/extension/sites.mjs";

const fixture = `<title>示例文章</title><nav>导航</nav><article><h1>城市观察</h1>
  <p>第一段是正文。</p><p>最后一段是结尾。</p></article>
  <label for="q">主题</label><input id="q">
  <button id="preview">预览</button><div id="result"></div>
  <select aria-label="语言"><option value="en">English</option><option value="zh">中文</option></select>
  <button hidden>隐藏按钮</button><input type="password" aria-label="密码">
  <input autocomplete="one-time-code" aria-label="验证码">`;
const url = "https://news.example.test/article";
const pattern = "https://news.example.test/*";

function page() {
  const { window } = new JSDOM(fixture, { url, runScripts: "outside-only", pretendToBeVisual: true });
  // jsdom has no layout engine. Model only the visible boxes in this fixture.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }, set(value) { this.textContent = value; }
  });
  window.Element.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  Object.defineProperty(window, "crypto", { value: webcrypto });
  const run = window.eval("(" + runOnPage.toString() + ")");
  const input = window.document.querySelector("#q");
  let inputEvents = 0;
  input.addEventListener("input", () => { inputEvents++; });
  window.document.querySelector("#preview").onclick = () => {
    window.document.querySelector("#result").textContent = "已预览 " + input.value;
  };
  return { run: (command, expectedUrl = url, currentOnly = false) => run(command, expectedUrl, currentOnly),
    window, input, inputEvents: () => inputEvents };
}

test("reads visible article text and retrieves the next chunk", () => {
  const { run, window } = page();
  let r = run({ action: "read", offset: 0 });
  assert.match(r.text, /最后一段是结尾/);
  assert.doesNotMatch(r.text, /导航|预览/);
  window.document.querySelector("article").textContent = "中".repeat(16000) + "尾";
  r = run({ action: "read", offset: 0 });
  assert.ok(r.nextOffset > 0);
  const end = run({ action: "read", offset: r.nextOffset });
  assert.equal(r.text + end.text, "中".repeat(16000) + "尾");
  assert.equal(end.nextOffset, null);
});

test("overlapping reads retain distinct article revisions and release completed snapshots", async () => {
  const { window, run } = page();
  await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  const article = window.document.querySelector("article");
  article.textContent = "A".repeat(12000) + "OLD";
  const old = run({ action: "read-start" });
  article.textContent = "B".repeat(12000) + "NEW";
  const fresh = run({ action: "read-start" });
  assert.notEqual(old.snapshotId, fresh.snapshotId);
  const tail = first => run({ action: "read", offset: first.nextOffset, snapshotId: first.snapshotId });
  assert.equal(run({ action: "read", offset: old.nextOffset }).error, "SNAPSHOT_REQUIRED");
  assert.equal(old.text + tail(old).text, "A".repeat(12000) + "OLD");
  assert.equal(tail(old).error, "SNAPSHOT_EXPIRED");
  assert.equal(fresh.text + tail(fresh).text, "B".repeat(12000) + "NEW");
  const abandoned = run({ action: "read-start" });
  const later = window.Date.now() + 121000;
  window.Date.now = () => later;
  assert.equal(tail(abandoned).error, "SNAPSHOT_EXPIRED");
  window.close();
});

test("article readiness ignores surrounding navigation and accepts short real articles", async () => {
  const { window, run } = page();
  await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  const article = window.document.querySelector("article");
  const start = value => run({ action: "read-start", value });
  for (const text of ["正在加载正文…", "Loading article...", "请稍候"]) {
    article.textContent = text;
    assert.equal(start().reason, "CONTENT_NOT_READY");
  }
  article.innerHTML = "<h1>本日新闻</h1><p>正在加载…</p>";
  assert.equal(start().reason, "CONTENT_NOT_READY");
  article.textContent = "";
  assert.equal(start().reason, "NO_PAGE_TEXT");
  article.textContent = "好";
  article.setAttribute("aria-busy", "true");
  assert.equal(start().reason, "CONTENT_NOT_READY");
  article.removeAttribute("aria-busy");
  assert.equal(start("预览").reason, "EXPECTED_TEXT_MISSING");
  assert.equal(start("好").text, "好");
  window.close();
});

test("a chunk boundary preserves emoji for the native UTF-8 transport", () => {
  const { window, run } = page();
  const text = "字".repeat(11999) + "🌱结尾";
  window.document.querySelector("article").textContent = text;
  const first = run({ action: "read" });
  const last = run({ action: "read", offset: first.nextOffset, snapshotId: first.snapshotId });
  assert.equal(first.nextOffset, 11999);
  assert.equal(last.text, "🌱结尾");
  assert.equal(first.text + last.text, text);
  window.close();
});

test("fills, clicks, selects and refuses old or replaced controls", () => {
  const { run, window, input, inputEvents } = page();
  const controls = run({ action: "controls" }).controls;
  assert.deepEqual([...controls.map(x => x.label)], ["主题", "预览", "语言"]);
  const [field, button, select] = controls;
  assert.equal(run({ action: "fill", ref: field.ref, value: "中文正文" }).matched, true);
  assert.equal(input.value, "中文正文");
  assert.equal(inputEvents(), 1);
  assert.equal(run({ action: "check", ref: field.ref, value: "中文正文" }).matched, true);
  assert.equal(run({ action: "check", ref: field.ref, value: "错误" }).matched, false);
  assert.equal(inputEvents(), 1);
  run({ action: "click", ref: button.ref });
  assert.equal(window.document.querySelector("#result").textContent, "已预览 中文正文");
  run({ action: "select", ref: select.ref, value: "中文" });
  assert.equal(window.document.querySelector("select").value, "zh");
  input.replaceWith(window.document.createElement("input"));
  assert.equal(run({ action: "fill", ref: field.ref, value: "wrong" }).error, "STALE_REF");
  window.document.querySelector("#preview").textContent = "另一操作";
  assert.equal(run({ action: "click", ref: button.ref }).error, "STALE_REF");
  run({ action: "controls" });
  assert.equal(run({ action: "click", ref: button.ref }).error, "STALE_REF");
  assert.equal(run({ action: "read" }, "https://other.example.test/").error, "PAGE_CHANGED");
});

function mockChrome() {
  const p = page();
  const grant = new Set([pattern, "tabs", "file:///*"]);
  const shared = { ["site:" + new URL(url).origin]: true };
  const tabs = [{ id: 7, title: "示例文章", url, active: true, windowId: 1 },
    { id: 8, url: "https://private.example.test/", title: "private tab", windowId: 1 },
    { id: 9, url: "https://news.example.test:8443/", title: "other port", windowId: 1 }];
  let lastWindow = 1;
  const calls = [];
  const session = {};
  function tabEvent() {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
      fire: (...args) => Promise.all([...listeners].map(fn => fn(...args))) };
  }
  const api = {
    storage: { local: { get: async () => ({ ...shared }) },
      session: { get: async key => key == null ? { ...session } : { [key]: session[key] },
        set: async values => Object.assign(session, values),
        remove: async keys => { for (const key of [keys].flat()) delete session[key]; } } },
    permissions: { contains: async ({ origins = [], permissions = [] }) => permissions.every(p => grant.has(p)) &&
      origins.every(o => grant.has(o) || grant.has(o.split("://")[0] + "://*/*")) },
    extension: { isAllowedFileSchemeAccess: async () => false },
    tabs: { get: async id => tabs.find(t => t.id === id),
      onActivated: tabEvent(), onUpdated: tabEvent(), onRemoved: tabEvent(),
      query: async ({ active, lastFocusedWindow, currentWindow, url: patterns }) => tabs.filter(t => {
        if (active && !t.active || (lastFocusedWindow || currentWindow) && t.windowId !== lastWindow) return false;
        if (!patterns) return true;
        const u = new URL(t.url);
        return patterns.includes(u.protocol + "//*/*") || patterns.includes(u.protocol + "//" + u.hostname + "/*");
      }),
      update: async (id, props) => {
        calls.push({ update: id, ...props });
        const tab = tabs.find(t => t.id === id);
        if (props.active) tabs.filter(t => t.windowId === tab.windowId).forEach(t => { t.active = t.id === id; });
        return tab;
      },
      create: async props => {
        calls.push(props);
        const tab = { id: Math.max(...tabs.map(t => t.id)) + 1, windowId: lastWindow, ...props };
        if (tab.active) tabs.filter(t => t.windowId === lastWindow).forEach(t => { t.active = false; });
        tabs.push(tab);
        return tab;
      } },
    windows: { onFocusChanged: tabEvent(), update: async id => { calls.push({ focus: id }); lastWindow = id; } },
    scripting: { executeScript: async ({ target, func, args }) => {
      assert.equal(func, runOnPage);
      assert.equal(target.tabId, 7);
      calls.push(target);
      return [{ frameId: 0, documentId: "doc-7", result: p.run(...args) }];
    } }
  };
  return { api, calls, grant, shared, tabs };
}

test("global access requires browser consent and works on newly selected ordinary sites", async () => {
  const { api, grant, shared, tabs } = mockChrome();
  shared.allSites = true;
  const visibleIds = async () => (await dispatch(api, { action: "tabs" })).tabs.map(t => t.id).sort();
  tabs[0].active = false;
  tabs[1].active = true;
  assert.deepEqual(await visibleIds(), [7]);
  await assert.rejects(dispatch(api, { action: "read", tabId: 8 }), /SITE_NOT_SHARED/);
  grant.add("http://*/*"); grant.add("https://*/*");
  assert.deepEqual(await visibleIds(), [7, 8]);
  api.scripting.executeScript = async ({ target, args }) => {
    assert.equal(target.tabId, 8);
    assert.equal(args[2], true);
    return [{ frameId: 0, documentId: "d8", result: { text: "第二站" } }];
  };
  assert.equal((await dispatch(api, { action: "read", tabId: 8 })).text, "第二站");
  await assert.rejects(dispatch(api, { action: "read", tabId: 9 }), /TAB_NOT_CURRENT/);
  shared["site:https://private.example.test"] = false;
  assert.deepEqual(await visibleIds(), [7]);
  await assert.rejects(dispatch(api, { action: "read", tabId: 8 }), /SITE_NOT_SHARED/);
  delete shared["site:https://private.example.test"];
  tabs[1].incognito = true;
  assert.deepEqual(await visibleIds(), [7]);
  tabs[1].incognito = false;
  for (const protectedUrl of ["chrome://settings/", "file:///C:/fixture.html", "https://chromewebstore.google.com/detail/test"]) {
    tabs[1].url = protectedUrl;
    assert.deepEqual(await visibleIds(), [7]);
    await assert.rejects(dispatch(api, { action: "read", tabId: 8 }),
      protectedUrl.startsWith("file:") ? /FILE_ACCESS_REQUIRED/ : /SITE_NOT_SHARED/);
  }
  tabs[1].url = "https://private.example.test/";
  grant.delete("https://*/*");
  assert.deepEqual(await visibleIds(), [7]);
  await assert.rejects(dispatch(api, { action: "read", tabId: 8 }), /SITE_NOT_SHARED/);
});

test("background open, wait and read leave the user's tab selected and reuse the task tab", async () => {
  const { api, grant, shared, tabs, calls } = mockChrome();
  shared.allSites = true;
  grant.add("http://*/*"); grant.add("https://*/*");
  const r = await dispatch(api, { action: "open", url: tabs[1].url });
  assert.equal(r.tabId, 10);
  assert.equal(r.siteShared, true);
  assert.deepEqual(calls, [{ url: tabs[1].url, windowId: 1, active: false }]);
  let polls = 0;
  api.scripting.executeScript = async ({ target, args: [command, expected, currentOnly] }) => {
    assert.equal(target.tabId, r.tabId);
    assert.equal(expected, tabs[1].url);
    assert.equal(currentOnly, false);
    return [{ frameId: 0, documentId: "d10", result: command.action === "wait" ?
      { matched: ++polls >= 2 } : { text: "已载入" } }];
  };
  assert.equal((await dispatch(api, { action: "wait", tabId: 10, condition: "text", value: "已载入", timeoutMs: 2000 })).matched, true);
  assert.equal((await dispatch(api, { action: "read", tabId: 10 })).text, "已载入");
  assert.equal((await dispatch(api, { action: "select-text", tabId: 10, value: "已载入" })).text, "已载入");
  assert.equal((await dispatch(api, { action: "open", url: tabs[1].url })).tabId, 10);
  assert.equal((await dispatch(api, { action: "open", url })).tabId, 7);
  assert.deepEqual((await dispatch(api, { action: "tabs" })).tabs.map(t => t.id).sort((a,b) => a-b), [7,10]);
  await assert.rejects(dispatch(api, { action: "click", tabId: 10, ref: "x" }), /TAB_NOT_CURRENT/);
  await assert.rejects(dispatch(api, { action: "read", tabId: 8 }), /TAB_NOT_CURRENT/);
  assert.equal(tabs.find(t => t.active).id, 7);
  assert.equal(calls.length, 1);
  shared["site:https://private.example.test"] = false;
  await assert.rejects(dispatch(api, { action: "read", tabId: 10 }), /SITE_NOT_SHARED/);
  tabs.find(t => t.id === 10).url = "https://other.example.test/";
  await assert.rejects(dispatch(api, { action: "read", tabId: 10 }), /TAB_NOT_CURRENT/);
});

test("only explicit foreground open activates the existing tab and window", async () => {
  const { api, grant, shared, tabs, calls } = mockChrome();
  shared.allSites = true;
  grant.add("http://*/*"); grant.add("https://*/*");
  const r = await dispatch(api, { action: "open", url: tabs[1].url, focus: true });
  assert.equal(r.tabId, 8);
  assert.equal(tabs.find(t => t.active).id, 8);
  assert.deepEqual(calls, [{ update: 8, active: true }, { focus: 1 }]);
});

test("locate resolves named tabs without focusing them or granting page access", async () => {
  const { api, tabs, shared, calls } = mockChrome();
  const settings = { id: 15, windowId: 2, title: "设置", url: "chrome://settings/" };
  tabs.push(settings, { ...settings, id: 16, incognito: true },
    { id: 17, windowId: 1, title: "PDF: Chapter 1", url: "chrome-extension://example/reader.html" },
    { id: 18, windowId: 1, title: "https://impostor.example/", url: "https://elsewhere.example/" },
    { id: 19, windowId: 1, title: "data:text/plain,example", url: "data:text/plain,example" });
  const locate = value => dispatch(api, { action: "locate", value });
  assert.equal((await locate("设置")).tabs[0].id, 15);
  assert.deepEqual((await locate("https://impostor.example/")).tabs, []);
  const inline = (await locate("data:text/plain,example")).tabs[0];
  assert.equal(inline.url, undefined);
  assert.equal(inline.title, undefined);
  assert.deepEqual((await locate()).tabs.map(t => t.id), [7]);
  assert.deepEqual((await locate("chrome://settings")).tabs.map(t => [t.id,t.route,t.selected]), [[15,"browser-ui",false]]);
  const existing = await dispatch(api, { action: "open-background", url: "chrome://settings/" });
  assert.equal(existing.tabId, 15);
  assert.equal(existing.route, "browser-ui");
  await assert.rejects(dispatch(api, { action: "open-background", url: "chrome://downloads/" }), /TAB_NOT_FOUND/);
  assert.equal((await locate("PDF: Chapter 1")).tabs[0].route, "browser-ui");
  assert.equal((await locate("other port")).tabs[0].route, "site-permission");
  shared["site:https://news.example.test:8443"] = false;
  assert.equal((await locate("other port")).tabs[0].route, "excluded");
  assert.equal((await locate("absent")).tabs.length, 0);
  assert.deepEqual(calls, []);
  await assert.rejects(dispatch(api, { action: "read", tabId: 15 }), /SITE_NOT_SHARED/);
  const focus = value => dispatch(api, { action: "focus-tab", tabId: 15, value });
  await assert.rejects(focus("chrome://extensions/"), /TARGET_CHANGED/);
  assert.equal((await focus(settings.url)).selected, true);
  assert.equal((await locate()).tabs[0].id, 15);
});

test("file access follows Chrome's file setting and matches only an already open file", async () => {
  const { api, tabs, grant, calls } = mockChrome();
  const address = "file:///C:/fixture%20reader.html";
  tabs.push({ id: 15, windowId: 1, url: address, title: "本地阅读器" });
  const open = url => dispatch(api, { action: "open-background", url });
  assert.equal((await dispatch(api, { action: "locate", value: address })).tabs[0].route, "file-permission");
  await assert.rejects(open(address), /FILE_ACCESS_REQUIRED/);
  api.extension.isAllowedFileSchemeAccess = async () => true;
  assert.equal((await open(address)).tabId, 15);
  assert.equal((await dispatch(api, { action: "locate", value: address })).tabs[0].route, "page");
  assert.ok((await dispatch(api, { action: "tabs" })).tabs.some(t=>t.id===15));
  await assert.rejects(open("file:///C:/other.html"), /LOCAL_TAB_NOT_OPEN/);
  assert.deepEqual(calls, []);
  api.scripting.executeScript = async ({ target, args }) => {
    assert.equal(target.tabId, 15);
    assert.equal(args[1], address);
    return [{ frameId: 0, documentId: "file-doc", result: { text: "本地正文" } }];
  };
  assert.equal((await dispatch(api,{ action: "read",tabId:15 })).text, "本地正文");
  grant.delete("file:///*");
  await assert.rejects(dispatch(api, { action: "read", tabId: 15 }), /FILE_ACCESS_REQUIRED/);
});

test("a PDF viewer requests document or visible-viewer handling", () => {
  const { window, run } = page();
  window.document.body.innerHTML = '<embed type="application/pdf">';
  assert.equal(run({ action: "read-start" }).error, "PDF_VIEWER_REQUIRED");
  window.document.body.insertAdjacentHTML("beforeend", "<article>网页中的相关文档</article>");
  assert.equal(run({ action: "read" }).text, "网页中的相关文档");
  window.close();
});

test("concurrent quiet opens reuse only the task's own pending exact URL", async () => {
  const { api, tabs, shared, grant } = mockChrome();
  shared.allSites = true;
  grant.add("http://*/*"); grant.add("https://*/*");
  const request = { action: "open-background", url: "https://private.example.test/article?q=1" };
  const create = api.tabs.create;
  api.tabs.create = async options => {
    const tab = await create(options);
    return Object.assign(tab, { status: "loading", pendingUrl: options.url, url: "about:blank" });
  };
  tabs[1].status = "loading";
  tabs[1].pendingUrl = request.url;
  const [first, second] = await Promise.all([dispatch(api, request), dispatch(api, request)]);
  assert.notEqual(first.tabId, tabs[1].id);
  assert.equal(first.tabId, second.tabId);
  assert.equal(second.reused, true);
  assert.equal((await dispatch(api, request)).tabId, first.tabId);
  const other = await dispatch(api, { ...request, url: request.url + "2" });
  assert.notEqual(other.tabId, first.tabId);
  assert.equal(tabs.find(tab => tab.active).id, 7);
  (await api.tabs.get(first.tabId)).pendingUrl = "https://private.example.test/elsewhere";
  assert.notEqual((await dispatch(api, request)).tabId, first.tabId);
  shared["site:https://private.example.test"] = false;
  const unshared = { ...request, url: request.url + "3" };
  const unopened = await dispatch(api, unshared);
  const retry = await dispatch(api, unshared);
  assert.equal(retry.tabId, unopened.tabId);
  assert.equal(retry.siteShared, false);
});

test("quiet open does not start a new foreground window when Chrome has no normal window", async () => {
  const { api, tabs, calls } = mockChrome();
  tabs.length = 0;
  await assert.rejects(dispatch(api, { action: "open-background", url }), /NO_BACKGROUND_WINDOW/);
  assert.deepEqual(calls, []);
});

test("reuses an individually shared background tab across windows without focusing it", async () => {
  const { api, tabs, calls } = mockChrome();
  tabs[0].windowId = 2;
  tabs[1].active = true;
  assert.equal((await dispatch(api, { action: "open", url })).tabId, 7);
  assert.deepEqual(calls, []);
});

test("sentence selection spans inline markup and checks repeated and hidden matches", () => {
  const { run, window } = page();
  window.document.querySelector("article").innerHTML = "<p>开始<strong>读这</strong>一句。</p><p>重复词</p><p>重复词</p><p hidden>不可选</p>";
  const select = (value, occurrence) => run({ action: "select-text", value, occurrence });
  assert.equal(select("读这一句").text, "读这一句");
  assert.equal(window.getSelection().toString(), "读这一句");
  assert.equal(select("重复词").error, "TEXT_NOT_UNIQUE");
  assert.equal(select("重复词", 2).text, "重复词");
  assert.equal(window.getSelection().anchorNode.parentElement, window.document.querySelectorAll("article p")[2]);
  assert.equal(select("不可选").error, "TEXT_NOT_FOUND");
});

test("wait checks rendered body text, timeout and page readiness", async () => {
  const { api } = mockChrome();
  const wait = (condition, value) => dispatch(api, { action: "wait", tabId: 7, condition, value, timeoutMs: 0 });
  assert.equal((await wait("text", "预览")).matched, true);
  assert.equal((await wait("gone", "不存在")).matched, true);
  await assert.rejects(wait("text", "不存在"), /WAIT_TIMEOUT/);
  api.tabs.get = async () => ({ id: 7, status: "loading", pendingUrl: url });
  await assert.rejects(wait("ready"), /WAIT_TIMEOUT/);
});

test("wait finds an icon button by its accessible name, including input buttons with a value", async () => {
  const { run, window } = page();
  await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  window.document.body.insertAdjacentHTML("beforeend",
    '<button aria-label="开始朗读"></button><input type="button" value="暂停播放"><button hidden aria-label="退出阅读"></button>');
  const wait = value => run({ action: "wait", condition: "text", value }).matched;
  assert.equal(wait("朗读"), true);
  assert.equal(wait("暂停播放"), true);
  assert.equal(wait("退出阅读"), false);
});

test("wait recovers when navigation removes the document while Chrome is injecting", async () => {
  const { api } = mockChrome();
  const inject = api.scripting.executeScript;
  let attempts = 0;
  api.scripting.executeScript = request => {
    if (++attempts === 1) throw new Error("Frame with ID 0 was removed.");
    return inject(request);
  };
  assert.equal((await dispatch(api, { action: "wait", tabId: 7, condition: "ready" })).matched, true);
  assert.equal(attempts, 2);
});

test("screenshot never activates another tab or returns a capture after a tab switch", async () => {
  const { api, tabs, calls } = mockChrome();
  const png = "data:image/png;base64,iVBORw0KGgo=";
  let captured = 0;
  api.tabs.captureVisibleTab = async (id, options) => {
    assert.equal(id, 1);
    assert.deepEqual(options, { format: "png" });
    captured++;
    return png;
  };
  const shot = () => dispatch(api, { action: "screenshot", tabId: 7 });
  assert.equal((await shot()).png, png);
  tabs[0].active = false; tabs[1].active = true;
  await assert.rejects(shot(), /SCREENSHOT_TAB_NOT_VISIBLE/);
  assert.equal(captured, 1);
  tabs[0].active = true; tabs[1].active = false;
  api.tabs.captureVisibleTab = async () => {
    await api.tabs.onActivated.fire({ tabId: 8, windowId: 1 });
    await api.tabs.onActivated.fire({ tabId: 7, windowId: 1 });
    return png;
  };
  await assert.rejects(shot(), /SCREENSHOT_TARGET_CHANGED/);
  assert.deepEqual(calls, []);
});

test("foreground-only operations stop if the target becomes hidden during injection", () => {
  const { run, window } = page();
  const [term] = run({ action: "controls" }).controls;
  Object.defineProperty(window.document, "visibilityState", { value: "hidden" });
  assert.equal(run({ action: "fill", ref: term.ref, value: "wrong" }, url, true).error, "TAB_NOT_CURRENT");
  assert.equal(window.document.querySelector("#q").value, "");
});

test("the popup preserves website choices and shows file recovery only on a blocked file", async () => {
  const { api, shared, grant, tabs } = mockChrome();
  // This profile starts with an explicit grant for tab 7. Tab 8 is new.
  tabs[0].active = false;
  tabs[1].active = true;
  const origins = ["http://*/*", "https://*/*"];
  const requests = [];
  let approve = false;
  api.permissions.request = async options => {
    requests.push(options.origins);
    if (approve) for (const origin of options.origins) grant.add(origin);
    return approve;
  };
  api.storage.local.set = async record => Object.assign(shared, record);
  api.storage.local.remove = async key => { delete shared[key]; };
  api.runtime = { id: "test-id", getManifest: () => ({ version: "1.4.0" }), sendMessage: async () => ({ ready: true }) };
  const html = await readFile(new URL("../chrome-control/extension/popup.html", import.meta.url), "utf8");
  async function openPopup(instance) {
    globalThis.document = new JSDOM(html).window.document;
    await import("../chrome-control/extension/popup.mjs?global-test=" + instance);
    await new Promise(resolve => setImmediate(resolve));
    return document.querySelector("#all-sites");
  }
  const mode = async () => (await dispatch(api, { action: "status" })).allSites;
  globalThis.chrome = api;
  try {
    let box = await openPopup(1);
    assert.equal(box.checked, false);
    assert.equal(requests.length, 0);
    box.checked = true;
    await box.onchange();
    assert.equal(box.checked, false);
    assert.equal(await mode(), false);
    approve = true;
    box.checked = true;
    await box.onchange();
    assert.deepEqual(requests, [origins, origins]);
    assert.equal(await mode(), true);
    box = await openPopup(2);
    assert.equal(box.checked, true);
    const siteButton = document.querySelector("#toggle");
    assert.equal(siteButton.getAttribute("aria-checked"), "true");
    await siteButton.onclick();
    assert.equal(siteButton.getAttribute("aria-checked"), "false");
    await assert.rejects(dispatch(api, { action: "read", tabId: 8 }), /SITE_NOT_SHARED/);
    await siteButton.onclick();
    assert.ok((await dispatch(api, { action: "tabs" })).tabs.some(t => t.id === 8));
    box.checked = false;
    await box.onchange();
    assert.equal(await mode(), false);
    assert.equal(shared.allSites, false);
    assert.equal(grant.has("https://*/*"), true);
    assert.deepEqual((await dispatch(api, { action: "tabs" })).tabs.map(t => t.id), [7]);
    assert.equal(requests.length, 2);
    for (const [index, address] of ["chrome://extensions/", "file:///C:/fixture.html",
      "https://chromewebstore.google.com/detail/test", undefined].entries()) {
      tabs[1].url = address;
      box = await openPopup("restricted-" + index);
      assert.equal(document.querySelector("#site-access").hidden, true);
      assert.equal(document.querySelector("#toggle").disabled, true);
      assert.equal(document.querySelector("#scope").textContent, "");
      assert.equal(document.querySelector("#connection").textContent, "已连接");
      assert.equal(document.querySelector("#file-issue").hidden, !address?.startsWith("file:"));
      assert.equal(box.disabled, false);
    }
    box.checked = true;
    await box.onchange();
    assert.equal(box.checked, true);
    assert.equal(requests.length, 2);
    assert.equal(document.querySelector("#site-access").hidden, true);
    tabs[1].url = "http://localhost:3000/reader";
    await openPopup("localhost");
    assert.equal(document.querySelector("#site-access").hidden, false);
    assert.equal(document.querySelector("#origin").textContent, "http://localhost:3000");
    assert.equal(document.querySelector("#toggle").disabled, false);
    assert.equal(document.querySelector("details, #tab-lookup, #file-access"), null);
    assert.equal(document.querySelector("#file-issue").hidden, true);
    tabs[1].url = "file:///C:/fixture.html";
    await openPopup("file-blocked");
    assert.equal(document.querySelector("#file-issue").hidden, false);
    const settingsPage = await document.querySelector("#file-settings").onclick();
    assert.equal(settingsPage.url, "chrome://extensions/?id=test-id");
    api.extension.isAllowedFileSchemeAccess = async () => true;
    await openPopup("file-enabled");
    assert.equal(document.querySelector("#file-issue").hidden, true);
    assert.equal(requests.length, 2);
    api.runtime.sendMessage = async () => ({ready:false,detail:"未连接到测试主机"});
    await openPopup("offline");
    assert.equal(document.querySelector("#connection").dataset.state, "offline");
    assert.equal(document.querySelector("#connection-issue").hidden, false);
    api.runtime.sendMessage = async () => ({ready:true});
    await document.querySelector("#retry").onclick();
    assert.equal(document.querySelector("#connection").dataset.state, "ready");
    assert.equal(document.querySelector("#connection-issue").hidden, true);
  } finally {
    delete globalThis.chrome;
    delete globalThis.document;
  }
});
test("scope applies to tabs, direct ID, revocation, ports and navigation", async () => {
  const { api, calls, grant, shared } = mockChrome();
  assert.deepEqual((await dispatch(api, { action: "tabs" })).tabs.map(t => t.id), [7]);
  await assert.rejects(dispatch(api, { action: "read", tabId: 8 }), /SITE_NOT_SHARED/);
  await assert.rejects(dispatch(api, { action: "read", tabId: 9 }), /SITE_NOT_SHARED/);
  await assert.rejects(dispatch(api, { action: "open", url: "chrome://settings/" }), /TAB_NOT_FOUND/);
  await assert.rejects(dispatch(api, { action: "eval", tabId: 7 }), /UNKNOWN_ACTION/);
  assert.equal(calls.length, 0);
  assert.equal((await dispatch(api, { action: "read", tabId: 7 })).documentId, "doc-7");
  grant.clear();
  await assert.rejects(dispatch(api, { action: "controls", tabId: 7 }), /SITE_NOT_SHARED/);
  grant.add(pattern);
  delete shared["site:" + new URL(url).origin];
  await assert.rejects(dispatch(api, { action: "read", tabId: 7 }), /SITE_NOT_SHARED/);
  assert.equal(calls.length, 1);
});

test("navigation in progress is distinguished from a site permission request", async () => {
  const { api } = mockChrome();
  api.tabs.get = async () => ({ id: 7, status: "loading", pendingUrl: url });
  await assert.rejects(dispatch(api, { action: "read", tabId: 7 }), /PAGE_LOADING/);
});

test("manifest declares tab lookup, websites and local files at install with a fixed extension ID", async () => {
  const m = JSON.parse(await readFile(new URL("../chrome-control/extension/manifest.json", import.meta.url)));
  const hash = await webcrypto.subtle.digest("SHA-256", Buffer.from(m.key, "base64"));
  const id = Buffer.from(hash).toString("hex").slice(0, 32).replace(/./g, c => String.fromCharCode(97 + parseInt(c, 16)));
  assert.equal(id, "bijbehalbilfcmgoedjidbgmjjanokah");
  assert.deepEqual(m.permissions.slice().sort(), ["activeTab", "nativeMessaging", "scripting", "storage", "tabs"]);
  assert.deepEqual(m.host_permissions.slice().sort(), ["file:///*", "http://*/*", "https://*/*"]);
  assert.ok(!m.optional_permissions && !m.optional_host_permissions && !m.externally_connectable && !m.content_scripts);
});

test("one site grant and one native port cover a sequence of commands until revoked", async () => {
  function event() {
    const handlers = [];
    return { addListener(fn) { handlers.push(fn); }, fire: (...args) => Promise.all(handlers.map(fn => fn(...args))) };
  }
  const { api, grant, shared } = mockChrome();
  grant.clear();
  for (const key of Object.keys(shared)) delete shared[key];
  let prompts = 0, connections = 0;
  const replies = new Map();
  const port = { onMessage: event(), onDisconnect: event(), postMessage: m => replies.set(m.id, m.reply) };
  api.permissions.request = async ({ origins }) => { prompts++; origins.forEach(o => grant.add(o)); return true; };
  api.permissions.remove = async ({ origins }) => { origins.forEach(o => grant.delete(o)); return true; };
  api.permissions.onRemoved = event();
  api.storage.local.set = async record => Object.assign(shared, record);
  api.storage.local.remove = async key => { delete shared[key]; };
  api.runtime = {
    onStartup: event(), onInstalled: event(), onMessage: event(), getURL: name => "chrome-extension://test/" + name,
    connectNative() { connections++; return port; },
    sendMessage: msg => new Promise(resolve => api.runtime.onMessage.fire(msg, { url: api.runtime.getURL("popup.html") }, resolve))
  };
  const popup = await readFile(new URL("../chrome-control/extension/popup.html", import.meta.url), "utf8");
  globalThis.chrome = api;
  globalThis.document = new JSDOM(popup).window.document;
  try {
    await import("../chrome-control/extension/worker.mjs");
    const boot = api.runtime.onInstalled.fire({ reason: "update", previousVersion: "1.3.0" });
    await port.onMessage.fire({ type: "ready" });
    await boot;
    assert.equal(shared.allSites, undefined);
    await api.runtime.onStartup.fire();
    const task = "task:7";
    const origin = new URL(url).origin;
    await api.storage.session.set({ [task]: origin });
    await api.tabs.onUpdated.fire(7, { url: origin + "/redirect" });
    assert.equal((await api.storage.session.get(task))[task], origin);
    await api.tabs.onUpdated.fire(7, { url: "https://other.example.test/" });
    assert.equal((await api.storage.session.get(task))[task], undefined);
    await api.storage.session.set({ [task]: origin });
    await api.tabs.onActivated.fire({ tabId: 7, windowId: 1 });
    assert.equal((await api.storage.session.get(task))[task], undefined);
    await api.storage.session.set({ [task]: origin });
    await api.tabs.onRemoved.fire(7);
    assert.equal((await api.storage.session.get(task))[task], undefined);
    await import("../chrome-control/extension/popup.mjs");
    await new Promise(resolve => setImmediate(resolve));
    const toggle = document.querySelector("#toggle");
    assert.equal(toggle.disabled, false);
    await toggle.onclick();
    const command = async (id, cmd) => {
      await port.onMessage.fire({ id, command: cmd });
      return replies.get(id);
    };
    const read = await command("1", { action: "read", tabId: 7 });
    assert.match(read.data.text, /最后一段/);
    const listed = await command("2", { action: "controls", tabId: 7 });
    const [field, button] = listed.data.controls;
    assert.equal((await command("3", { action: "fill", tabId: 7, ref: field.ref, value: "测试" })).data.matched, true);
    assert.equal((await command("4", { action: "click", tabId: 7, ref: button.ref })).data.dispatched, true);
    assert.equal(prompts, 1);
    assert.equal(connections, 1);
    await toggle.onclick();
    assert.equal((await command("5", { action: "read", tabId: 7 })).error, "SITE_NOT_SHARED");
    assert.equal(prompts, 1);
    shared.allSites = true;
    grant.add("http://*/*");
    await api.permissions.onRemoved.fire({ origins: ["https://*/*"] });
    assert.notEqual(shared.allSites, true);
    const excluded = "site:" + new URL(url).origin;
    await api.runtime.onInstalled.fire({ reason: "update", previousVersion: "1.3.0" });
    assert.notEqual(shared.allSites, true);
    assert.equal(shared[excluded], false);
    delete shared[excluded];
    grant.add("https://*/*");
    await api.runtime.onInstalled.fire({ reason: "install" });
    assert.equal((await accessSettings(api)).allSites, true);
    await api.runtime.onInstalled.fire({ reason: "update" });
    assert.equal(shared.allSites, true);
    assert.equal(prompts, 1);
  } finally {
    delete globalThis.chrome;
    delete globalThis.document;
  }
});
