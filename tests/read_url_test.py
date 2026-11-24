"""Exercise the PowerShell reading entry point without a registry or a real Chrome profile."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "chrome-control/scripts"
URL = "https://example.test/article?a=1&b=2#one"
DOC = "document-41"
OPEN = {"ok": True, "data": {"tabId": 41, "requestedUrl": URL, "siteShared": True}}
SNAP = "snapshot-41"
STUB = r"""
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'calls.jsonl'
$index = [IO.File]::ReadAllLines($log).Length
$call = ConvertTo-Json -Compress -InputObject ([string[]]$args)
[IO.File]::AppendAllText($log, $call + [Environment]::NewLine)
$reply = [IO.File]::ReadAllText((Join-Path $PSScriptRoot ("reply-{0}.json" -f $index)))
Write-Output $reply
if (-not ($reply | ConvertFrom-Json).ok) { exit 1 }
exit 0
"""


def chunk(text, offset, total, next_offset, **changed):
    data = dict(url=URL, documentId=DOC, snapshotId=SNAP, title="标题", source="article", text=text,
                offset=offset, total=total, nextOffset=next_offset)
    if offset == 0:
        data["matched"] = True
    return {"ok": True, "data": {**data, **changed}}


class ReadUrlTest(unittest.TestCase):
    def run_reader(self, replies, arguments=(URL,), shell="powershell.exe"):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            shutil.copyfile(SCRIPTS / "read-url.ps1", path / "read-url.ps1")
            (path / "chrome.ps1").write_text(STUB, encoding="ascii")
            log = path / "calls.jsonl"
            log.touch()
            for i, reply in enumerate(replies):
                (path / f"reply-{i}.json").write_text(json.dumps(reply), encoding="utf-8")
            result = subprocess.run([shell, "-NoProfile", "-File", path / "read-url.ps1", *arguments],
                                    capture_output=True, timeout=20)
            self.assertTrue(result.stdout, result.stderr.decode(errors="replace"))
            reply = json.loads(result.stdout)
            self.assertEqual(result.returncode == 0, reply["ok"], reply)
            return reply, [json.loads(line) for line in log.read_text(encoding="utf-8-sig").splitlines()]

    def test_background_open_wait_and_pinned_pages_in_one_call(self):
        for shell in ["powershell.exe", "pwsh.exe"]:
            with self.subTest(shell=shell):
                prefix = "正" * 12000
                replies = [OPEN, chunk(prefix, 0, 12002, 12000), chunk("末段", 12000, 12002, None)]
                result, calls = self.run_reader(replies, shell=shell)
                self.assertEqual(calls, [["open", URL], ["read-start", "41"], ["read", "41", "12000", DOC, SNAP]])
                self.assertEqual(result["data"]["text"], prefix + "末段")
                self.assertEqual(result["data"]["url"], URL)
                self.assertEqual(result["data"]["tabId"], 41)
                self.assertIsNone(result["data"]["nextOffset"])

    def test_denials_keep_their_stage_and_stop(self):
        for replies, error, stage, tab in [
            ([{"ok": False, "error": "REGISTRY_ACCESS_DENIED"}], "REGISTRY_ACCESS_DENIED", "open", None),
            ([{"ok": True, "data": {"tabId": 41, "siteShared": False}}], "SITE_NOT_SHARED", "open", 41),
            ([OPEN, {"ok": False, "error": "WAIT_TIMEOUT"}], "WAIT_TIMEOUT", "wait", 41),
            ([OPEN, {"ok": False, "error": "CONTENT_NOT_READY", "detail": URL}], "CONTENT_NOT_READY", "wait", 41),
            ([OPEN, chunk("首", 0, 2, 1), {"ok": False, "error": "SITE_NOT_SHARED"}], "SITE_NOT_SHARED", "read", 41),
            ([OPEN, chunk("", 0, 0, None)], "NO_PAGE_TEXT", "read", 41),
        ]:
            with self.subTest(error=error, stage=stage):
                result, calls = self.run_reader(replies)
                self.assertEqual((result["error"], result["stage"], result.get("tabId")), (error, stage, tab))
                self.assertEqual(len(calls), len(replies))
                if error == "CONTENT_NOT_READY":
                    self.assertEqual(result["detail"], URL)

    def test_waits_for_expected_text_in_the_same_background_read(self):
        value = "下半段的特定文字"
        result, calls = self.run_reader([OPEN, chunk(value, 0, len(value), None, snapshotId=None)],
                                        arguments=(URL, "-WaitText", value))
        self.assertEqual(result["data"]["text"], value)
        self.assertEqual(calls, [["open", URL], ["read-start", "41", value]])
        self.assertNotIn("snapshotId", result["data"])

    def test_preserves_timestamp_text_literally(self):
        value = "2026-11-22T12:00:00Z"
        for shell in ["powershell.exe", "pwsh.exe"]:
            with self.subTest(shell=shell):
                result, _ = self.run_reader([OPEN, chunk(value, 0, len(value), None)], shell=shell)
                self.assertEqual(result["data"]["text"], value)

    def test_rejects_changed_pages_and_broken_pagination(self):
        for second, error in [(chunk("尾", 1, 2, None, url=URL + "-other"), "PAGE_CHANGED"),
                              (chunk("尾", 1, 2, None, documentId="other"), "PAGE_CHANGED"),
                              (chunk("尾", 1, 2, None, snapshotId="other"), "PAGE_CHANGED"),
                              (chunk("尾", 1, 3, 2), "PAGE_CHANGED"),
                              (chunk("", 1, 2, 1), "INVALID_PAGE_RESULT")]:
            with self.subTest(second=second):
                result, calls = self.run_reader([OPEN, chunk("首", 0, 2, 1), second])
                self.assertEqual(result["error"], error)
                self.assertEqual(result["tabId"], 41)
                self.assertNotIn("data", result)
                self.assertEqual(len(calls), 3)

    def test_arguments_cannot_add_browser_actions(self):
        for args in [(URL, "--focus"), (URL, "--focus", "x"), (URL, "-WaitText", " "), ("file:///C:/test",), ()]:
            with self.subTest(arguments=args):
                result, calls = self.run_reader([], arguments=args)
                self.assertFalse(result["ok"])
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
