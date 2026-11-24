"""Exercise the real Windows native host and CLI against a simulated Chrome port."""
import json
import base64
import io
from queue import Empty, Queue
from pathlib import Path
import struct
import subprocess
import tempfile
from threading import Thread
import unittest
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "chrome-extension://bijbehalbilfcmgoedjidbgmjjanokah/"


def read_frame(stream):
    header = stream.read(4)
    if len(header) != 4:
        raise EOFError("Host closed its native messaging output")
    size, = struct.unpack("<I", header)
    return json.loads(stream.read(size))


def receive(stream, stage):
    result = Queue()
    def read():
        try:
            result.put(read_frame(stream))
        except Exception as error:
            result.put(error)
    Thread(target=read, daemon=True).start()
    try:
        value = result.get(timeout=7)
    except Empty:
        raise AssertionError("No native message at " + stage) from None
    if isinstance(value, Exception):
        raise value
    return value


def send(stream, message):
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("<I", len(payload)) + payload)
    stream.flush()


class BridgeTest(unittest.TestCase):
    def test_roundtrip_and_lifecycle(self):
        with tempfile.TemporaryDirectory() as temporary:
            subprocess.run(["powershell.exe", "-NoProfile", "-File",
                            str(ROOT / "chrome-control/scripts/setup.ps1"),
                            "-BuildOnly", "-OutputDirectory", temporary], check=True, timeout=40)
            exe, = Path(temporary).glob("*.exe")
            # Use a different, compile-time pipe name for tests. A running personal
            # Chrome profile must never receive test commands.
            with subprocess.Popen([exe, ORIGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as host:
                try:
                    self.assertEqual(receive(host.stdout, "host startup")["type"], "ready")
                    duplicate = subprocess.run([exe, ORIGIN], capture_output=True, timeout=5)
                    self.assertNotEqual(duplicate.returncode, 0)
                    self.assertIn(b"PROFILE_BUSY", duplicate.stdout)
                    for args, expected in [(["read", "37", "12", "doc-1"],
                                             {"action": "read", "tabId": 37, "offset": 12, "documentId": "doc-1"}),
                                            (["fill", "37", "abc.2", "中文 空格"], 
                                             {"action": "fill", "tabId": 37, "ref": "abc.2", "value": "中文 空格"}),
                                            (["click", "37", "abc.1"], {"action": "click", "tabId": 37, "ref": "abc.1"}),
                                            (["open", "https://example.test/"], {"action": "open-background", "url": "https://example.test/"}),
                                            (["open", "https://example.test/", "--focus"], {"action": "open", "url": "https://example.test/", "focus": True}),
                                            (["wait", "37", "text", "就绪", "3500"], {"action": "wait", "tabId": 37, "condition": "text", "value": "就绪", "timeoutMs": 3500}),
                                            (["select-text", "37", "一段话", "2"], {"action": "select-text", "tabId": 37, "value": "一段话", "occurrence": 2})]:
                        with subprocess.Popen([exe, *args], stdout=subprocess.PIPE) as client:
                            try:
                                request = receive(host.stdout, args[0])
                            except AssertionError:
                                if client.poll() is not None:
                                    self.fail("Client exited before forwarding: " + client.stdout.read().decode("utf-8"))
                                raise
                            self.assertEqual(request["command"], expected)
                            send(host.stdin, {"id": "late-or-foreign", "reply": {"ok": False}})
                            send(host.stdin, {"id": request["id"], "reply": {"ok": True, "data": "收到"}})
                            output, _ = client.communicate(timeout=6)
                            self.assertEqual(json.loads(output)["data"], "收到")
                            self.assertEqual(client.returncode, 0)
                    with subprocess.Popen([exe, "--args-json"], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as client:
                        client.stdin.write(json.dumps(["fill", "37", "abc.2", ""], ensure_ascii=False).encode("utf-8"))
                        client.stdin.close()
                        request = receive(host.stdout, "empty field via JSON")
                        self.assertEqual(request["command"]["value"], "")
                        send(host.stdin, {"id": request["id"], "reply": {"ok": False, "error": "STALE_REF"}})
                        self.assertEqual(client.wait(timeout=5), 1)
                        self.assertEqual(json.loads(client.stdout.read())["error"], "STALE_REF")
                    with subprocess.Popen([exe, "open", "https://example.test/"], stdout=subprocess.PIPE) as client:
                        request = receive(host.stdout, "old extension")
                        self.assertEqual(request["command"]["action"], "open-background")
                        send(host.stdin, {"id": request["id"], "reply": {"ok": False, "error": "UNKNOWN_ACTION"}})
                        stdout, _ = client.communicate(timeout=5)
                        self.assertEqual(json.loads(stdout)["error"], "EXTENSION_RELOAD_REQUIRED")
                    # A whole viewport can exceed the 1 MiB host-to-Chrome command limit.
                    before = Path(temporary) / "截图 before.png"
                    with Image.effect_noise((1200, 1000), 55) as grey, io.BytesIO() as stream:
                        grey.convert("RGB").save(stream, format="PNG")
                        png = stream.getvalue()
                    self.assertGreater(len(png), 1024 * 1024)
                    with subprocess.Popen([exe, "screenshot", "37", before], stdout=subprocess.PIPE) as client:
                        request = receive(host.stdout, "screenshot")
                        self.assertEqual(request["command"], {"action": "screenshot", "tabId": 37})
                        send(host.stdin, {"id": request["id"], "reply": {"ok": True, "data": {
                            "url": "https://example.test/", "png": "data:image/png;base64," + base64.b64encode(png).decode()}}})
                        stdout, _ = client.communicate(timeout=10)
                        self.assertEqual(client.returncode, 0, stdout[:300])
                        self.assertLess(len(stdout), 1000)
                        self.assertEqual(json.loads(stdout)["data"]["path"], str(before))
                        self.assertEqual(before.read_bytes(), png)
                    after = before.with_name("after.png")
                    with Image.open(before) as im:
                        old = im.getpixel((17, 5))
                        im.putpixel((17, 5), (old[0] ^ 255, old[1], old[2]))
                        im.save(after)
                    delta = before.with_name("diff.png")
                    def diff(*files):
                        result = subprocess.run([exe, "diff", *files], capture_output=True, timeout=10)
                        return json.loads(result.stdout)
                    comparison = diff(before, after, delta)["data"]
                    self.assertEqual(comparison["changedPixels"], 1)
                    self.assertEqual(comparison["bounds"], {"x": 17, "y": 5, "width": 1, "height": 1})
                    with Image.open(delta) as marked:
                        self.assertEqual(marked.getpixel((17, 5))[:3], (255, 0, 128))
                    self.assertTrue(diff(before, before)["data"]["equal"])
                    self.assertEqual(diff(before, after, delta)["error"], "OUTPUT_EXISTS")
                    tiny = before.with_name("tiny.png")
                    Image.new("RGB", (1, 2)).save(tiny)
                    self.assertEqual(diff(before, tiny)["error"], "IMAGE_SIZE_MISMATCH")
                finally:
                    host.stdin.close()
                    host.wait(timeout=5)
            offline = subprocess.run([exe, "status"], capture_output=True, timeout=8)
            self.assertNotEqual(offline.returncode, 0)
            self.assertIn(b"BRIDGE_OFFLINE", offline.stdout)
            invalid = subprocess.run([exe, "fill", "7"], capture_output=True, timeout=5)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn(b"USAGE", invalid.stdout)


if __name__ == "__main__":
    unittest.main()
