"""Run the shipped page function in real Chrome on one offline HTML fixture."""
from html.parser import HTMLParser
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class Verdict(HTMLParser):
    result = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "output" and attrs.get("id") == "verdict":
            self.result = attrs.get("data-result")


class RendererTest(unittest.TestCase):
    def test_visible_read_and_form(self):
        candidates = [Path(os.environ.get(folder, "")) / "Google/Chrome/Application/chrome.exe"
                      for folder in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
        chrome = next(path for path in candidates if path.is_file())
        source = (ROOT / "chrome-control/extension/page.mjs").read_text(encoding="utf-8")
        source = source.replace("export function runOnPage", "function runOnPage", 1)
        fixture = """<!doctype html><meta charset="utf-8"><title>离线验证</title>
        <main><article><h1>测试文章</h1><p>可读的<strong>最后</strong>一段。</p><p hidden>隐藏文字</p>
        <p>复制一句。</p><p>复制一句。</p></article>
        <label>搜索词<input id="term"></label><button id="preview">预览</button>
        <p id="previewText"></p><output id="verdict"></output></main><script>"""
        checks = """
        const run = args => runOnPage(args, location.href, true);
        function expect(condition, message) { if (!condition) throw new Error(message); }
        try {
          const read = run({action:"read"});
          expect(read.text.includes("可读的最后一段") && !read.text.includes("隐藏文字"), "visible text");
          const selected = run({action:"select-text",value:"读的最后一段"});
          expect(selected.text === "读的最后一段" && getSelection().toString() === selected.text, "native selection");
          expect(run({action:"select-text",value:"复制一句。"}).error === "TEXT_NOT_UNIQUE", "ambiguous selection");
          expect(run({action:"select-text",value:"复制一句。",occurrence:2}).text === "复制一句。", "second occurrence");
          expect(run({action:"select-text",value:"隐藏文字"}).error === "TEXT_NOT_FOUND", "hidden selection");
          const controls = run({action:"controls"}).controls;
          const term = controls.find(item => item.label === "搜索词").ref;
          const button = controls.find(item => item.label === "预览").ref;
          const input = document.querySelector("#term");
          let observed = "";
          input.addEventListener("input", () => { observed = input.value; });
          document.querySelector("#preview").onclick = () => {
            document.querySelector("#previewText").textContent = "预览结果 " + observed;
          };
          expect(run({action:"fill",ref:term,value:"上海 Chrome"}).matched, "fill");
          expect(run({action:"check",ref:term,value:"上海 Chrome"}).matched, "field state");
          expect(run({action:"click",ref:button}).dispatched, "click");
          expect(document.querySelector("#previewText").innerText === "预览结果 上海 Chrome", "receipt");
          document.querySelector("#verdict").dataset.result = "passed";
        } catch (error) {
          document.querySelector("#verdict").dataset.result = error.message;
        }
        </script>"""
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            path = folder / "fixture.html"
            path.write_text(fixture + source + checks, encoding="utf-8")
            run = subprocess.run([chrome, "--headless", "--no-first-run", "--no-default-browser-check",
                                  "--disable-background-networking", "--disable-component-update",
                                  "--user-data-dir=" + str(folder / "empty-profile"), "--dump-dom", path.as_uri()],
                                 capture_output=True, timeout=35, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(run.returncode, 0, run.stderr.decode(errors="replace")[-700:])
            result = Verdict()
            result.feed(run.stdout.decode("utf-8"))
            self.assertEqual(result.result, "passed", run.stderr.decode(errors="replace")[-700:])


if __name__ == "__main__":
    unittest.main()
