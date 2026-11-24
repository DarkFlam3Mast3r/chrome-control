"""Real tab selection, page visibility and script injection in an empty Chromium test profile.

Set CHROME_FOR_TESTING to a Chromium test binary that supports --load-extension.
The temporary extension can access only the loopback fixture, and has no native host.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from queue import Empty, Queue
import shutil
import subprocess
import tempfile
from threading import Event, Thread
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKER = """
import { dispatch } from "./commands.mjs";
const base = FIXTURE_ORIGIN;
chrome.runtime.onInstalled.addListener(async () => {
  const call = command => dispatch(chrome, command);
  let result;
  try {
    await chrome.storage.local.set({ ["site:" + base]: true });
    const writing = await chrome.tabs.create({url:base+"/writing",active:true});
    await call({action:"wait",tabId:writing.id,condition:"ready"});
    const switches = [];
    chrome.tabs.onActivated.addListener(info => switches.push(info.tabId));
    const target = await call({action:"open-background",url:base+"/reader"});
    const wait = await call({action:"wait",tabId:target.tabId,condition:"text",value:"结尾"});
    const read = await call({action:"read",tabId:target.tabId});
    const selection = await call({action:"select-text",tabId:target.tabId,value:"第二句"});
    const reuse = await call({action:"open-background",url:base+"/reader"});
    const state = id => chrome.scripting.executeScript({target:{tabId:id},func:() => document.visibilityState});
    const [front] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
    let shot;
    try { await call({action:"screenshot",tabId:target.tabId}); }
    catch (e) { shot = e.message; }
    const quiet = url => call({action:"open-background",url:base+url});
    const [one,two] = await Promise.all([quiet("/slow"),quiet("/slow")]);
    const three = await quiet("/slow");
    await fetch(base+"/release-slow",{method:"POST"});
    await call({action:"wait",tabId:one.tabId,condition:"ready"});
    const {tabId} = await quiet("/async");
    const onArticle = (action, args={}) => call({action,tabId,...args});
    await onArticle("wait",{condition:"text",value:"Loading article..."});
    let placeholder;
    try { await onArticle("read-start",{timeoutMs:0}); }
    catch (e) { placeholder = e.message; }
    const reading = onArticle("read-start",{value:"OLD"});
    await fetch(base+"/release-text",{method:"POST"});
    const first = await reading;
    const loading = (await chrome.tabs.get(tabId)).status;
    await fetch(base+"/release-image",{method:"POST"});
    await onArticle("wait",{condition:"ready"});
    const button = (await onArticle("controls")).controls.find(c=>c.label==="换版");
    await onArticle("click",{ref:button.ref});
    const tail = await onArticle("read",{offset:first.nextOffset,documentId:first.documentId,snapshotId:first.snapshotId});
    const latest = await onArticle("read-start",{value:"NEW"});
    const latestTail = await onArticle("read",{offset:latest.nextOffset,documentId:latest.documentId,snapshotId:latest.snapshotId});
    result = {stayed:front.id===writing.id, switches, read:read.text, wait:wait.matched,
      selection:selection.text, reused:reuse.tabId===target.tabId, shot,
      samePendingTab:one.tabId===two.tabId && two.tabId===three.tabId, placeholder, loading,
      firstEdition:first.text+tail.text==="A".repeat(12000)+"OLD",
      nextEdition:latest.text+latestTail.text==="B".repeat(12000)+"NEW",
      writerVisibility:(await state(writing.id))[0].result, readerVisibility:(await state(target.tabId))[0].result};
  } catch (e) { result = {error:e.message}; }
  await fetch(base+"/verdict",{method:"POST",body:JSON.stringify(result)});
});
"""


class TabFocusTest(unittest.TestCase):
    def test_real_background_tab(self):
        executable = os.environ.get("CHROME_FOR_TESTING")
        if not executable:
            self.skipTest("Set CHROME_FOR_TESTING to a browser supporting unpacked test extensions.")
        verdict = Queue()
        gates = {key: Event() for key in ("slow", "text", "image")}

        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                mime = "text/html; charset=utf-8"
                if self.path == "/slow":
                    gates["slow"].wait(12)
                    body = "<article>慢速打开</article>"
                elif self.path == "/async":
                    body = """<title>同一篇文章</title>
                        <button onclick="document.querySelector('article').textContent='B'.repeat(12000)+'NEW'">换版</button>
                        <article>Loading article...</article><img src="/image.svg"><script>
                        document.addEventListener('DOMContentLoaded',async()=>{
                          const r=await fetch('/payload'); document.querySelector('article').textContent=await r.text();
                        });</script>"""
                elif self.path == "/payload":
                    gates["text"].wait(12)
                    body, mime = "A" * 12000 + "OLD", "text/plain"
                elif self.path == "/image.svg":
                    gates["image"].wait(12)
                    body, mime = "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>", "image/svg+xml"
                else:
                    body = ("<title>写文档</title><textarea>保留的草稿</textarea>" if self.path == "/writing" else
                            "<title>文章</title><article>第一句，<b>第二</b>句是结尾。</article>")
                data = body.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                if self.path.startswith("/release-") and self.path[9:] in gates:
                    gates[self.path[9:]].set()
                    self.send_response(204)
                    self.end_headers()
                    return
                if self.path != "/verdict":
                    self.send_error(404)
                    return
                length = int(self.headers["Content-Length"])
                result = json.loads(self.rfile.read(min(length, 8192)))
                self.send_response(204)
                self.end_headers()
                verdict.put(result)

        with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            folder = Path(tmp)
            extension = folder / "extension"
            extension.mkdir()
            for name in ("commands.mjs", "sites.mjs", "page.mjs", "screenshot.mjs"):
                shutil.copyfile(ROOT / "chrome-control/extension" / name, extension / name)
            base = "http://127.0.0.1:" + str(server.server_port)
            manifest = {"manifest_version": 3, "name": "Offline tab test", "version": "1.0",
                        "permissions": ["storage", "scripting"], "host_permissions": ["http://127.0.0.1/*"],
                        "background": {"service_worker": "test.mjs", "type": "module"}}
            (extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (extension / "test.mjs").write_text(WORKER.replace("FIXTURE_ORIGIN", json.dumps(base)), encoding="utf-8")
            args = [executable, "--headless", "--no-first-run", "--no-default-browser-check",
                    "--disable-background-networking", "--disable-component-update", "--user-data-dir=" + str(folder / "profile"),
                    "--load-extension=" + str(extension), "about:blank"]
            try:
                with subprocess.Popen(args, creationflags=subprocess.CREATE_NO_WINDOW,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as browser:
                    try:
                        result = verdict.get(timeout=35)
                    except Empty:
                        self.fail("The test extension did not report a result in the empty browser profile.")
                    finally:
                        for gate in gates.values():
                            gate.set()
                        browser.terminate()
                        browser.wait(timeout=8)
            finally:
                server.shutdown()
                worker.join()
            self.assertEqual(result, {"stayed": True, "switches": [], "read": "第一句，第二句是结尾。", "wait": True,
                                     "selection": "第二句", "reused": True, "shot": "SCREENSHOT_TAB_NOT_VISIBLE",
                                     "samePendingTab": True, "placeholder": "CONTENT_NOT_READY", "loading": "loading",
                                     "firstEdition": True, "nextEdition": True,
                                     "writerVisibility": "visible", "readerVisibility": "hidden"})


if __name__ == "__main__":
    unittest.main()
