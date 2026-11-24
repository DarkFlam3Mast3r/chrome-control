using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class ChromeControl
{
    private const string Origin = "chrome-extension://bijbehalbilfcmgoedjidbgmjjanokah/";
    private const int FrameLimit = 1024 * 1024;
    // Commands to Chrome stay below 1 MiB. Only replies can contain a viewport PNG.
    private const int ReplyLimit = 32 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
#if TEST_BRIDGE
    private const string PipePrefix = "CodexChromeControl.Tests.";
#else
    private const string PipePrefix = "CodexChromeControl.";
#endif
    private static readonly string PipeName = PipePrefix + User.Value;
    private static readonly string HostMutex = @"Local\" + PipeName;
    private static readonly HashSet<string> QueuedReads = new HashSet<string>
        { "status", "tabs", "locate", "read", "read-start", "wait", "controls", "check" };
    private static readonly ConcurrentDictionary<string, TaskCompletionSource<string>> Pending =
        new ConcurrentDictionary<string, TaskCompletionSource<string>>();

    private static string Json(object value)
    {
        return new JavaScriptSerializer { MaxJsonLength = ReplyLimit }.Serialize(value);
    }

    private static Dictionary<string, object> Parse(string text)
    {
        var result = new JavaScriptSerializer { MaxJsonLength = ReplyLimit }
            .Deserialize<Dictionary<string, object>>(text);
        if (result == null) throw new InvalidDataException("Expected a JSON object.");
        return result;
    }

    private static byte[] ReadBytes(Stream stream, int count, int timeoutMs)
    {
        var buffer = new byte[count];
        var clock = Stopwatch.StartNew();
        for (int offset = 0; offset < count;)
        {
            int received;
            if (timeoutMs < 0) received = stream.Read(buffer, offset, count - offset);
            else
            {
                var read = stream.ReadAsync(buffer, offset, count - offset);
                int remaining = Math.Max(0, timeoutMs - (int)clock.ElapsedMilliseconds);
                if (!read.Wait(remaining)) throw new TimeoutException("Incomplete pipe frame.");
                received = read.Result;
            }
            if (received == 0) throw new EndOfStreamException();
            offset += received;
        }
        return buffer;
    }

    private static string ReadFrame(Stream stream, int timeoutMs, int limit = FrameLimit)
    {
        int size = BitConverter.ToInt32(ReadBytes(stream, 4, timeoutMs), 0);
        if (size <= 0 || size > limit) throw new InvalidDataException("Invalid frame size.");
        return Utf8.GetString(ReadBytes(stream, size, timeoutMs));
    }

    private static void WriteFrame(Stream stream, string text, int limit = FrameLimit)
    {
        byte[] bytes = Utf8.GetBytes(text);
        if (bytes.Length > limit) throw new InvalidDataException("Response too large.");
        byte[] header = BitConverter.GetBytes(bytes.Length);
        stream.Write(header, 0, header.Length);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    private static NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        var network = new SecurityIdentifier(WellKnownSidType.NetworkSid, null);
        security.AddAccessRule(new PipeAccessRule(network, PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(User, PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 8192, 8192, security);
    }

    private static void ServeOne(NamedPipeServerStream pipe, Stream chrome)
    {
        pipe.WaitForConnection();
        var command = Parse(ReadFrame(pipe, 4000));
        string id = Guid.NewGuid().ToString("N");
        var waiter = new TaskCompletionSource<string>();
        Pending[id] = waiter;
        try
        {
            WriteFrame(chrome, Json(new { id = id, command = command }));
            string reply = waiter.Task.Wait(15000) ? waiter.Task.Result :
                Json(new { ok = false, error = "OUTCOME_UNKNOWN", detail = "Chrome did not acknowledge this request." });
            WriteFrame(pipe, reply, ReplyLimit);
        }
        finally
        {
            TaskCompletionSource<string> ignored;
            Pending.TryRemove(id, out ignored);
        }
    }

    private static void ServeClients(NamedPipeServerStream first, Stream chrome)
    {
        var next = first;
        while (true)
        {
            using (var pipe = next)
            {
                try { ServeOne(pipe, chrome); }
                catch (Exception error)
                {
                    try
                    {
                        if (pipe.IsConnected)
                            WriteFrame(pipe, Json(new { ok = false, error = "PIPE_ERROR", detail = error.GetBaseException().Message }));
                    }
                    catch (IOException) { }
                }
            }
            next = CreatePipe();
        }
    }

    private static int Host()
    {
        Stream output = Console.OpenStandardOutput();
        Stream input = Console.OpenStandardInput();
        bool created;
        using (var mutex = new Mutex(true, HostMutex, out created))
        {
            if (!created)
            {
                WriteFrame(output, Json(new { type = "error", error = "PROFILE_BUSY" }));
                return 2;
            }
            var first = CreatePipe();
            var server = new Thread(() => ServeClients(first, output)) { IsBackground = true };
            WriteFrame(output, Json(new { type = "ready" }));
            server.Start();
            // EOF from Chrome releases the process, including a waiting pipe listener.
            while (true)
            {
                Dictionary<string, object> message;
                try { message = Parse(ReadFrame(input, -1, ReplyLimit)); }
                catch (EndOfStreamException) { return 0; }
                object id, reply;
                TaskCompletionSource<string> waiter;
                if (message.TryGetValue("id", out id) && id is string && message.TryGetValue("reply", out reply) &&
                    Pending.TryGetValue((string)id, out waiter))
                    waiter.TrySetResult(Json(reply));
            }
        }
    }

    private const string Usage = "status | tabs | locate [TITLE_OR_URL] | focus-tab TAB TITLE_OR_URL | open URL [--focus] | read-start TAB [TEXT] | read TAB [OFFSET [DOCUMENT [SNAPSHOT]]] | " +
        "controls TAB [OFFSET] | click TAB REF | fill TAB REF TEXT | check TAB REF TEXT | select TAB REF OPTION | scroll TAB up|down | " +
        "select-text TAB TEXT [OCCURRENCE] | wait TAB ready [MS] | wait TAB text|gone TEXT [MS] | " +
        "screenshot TAB OUTPUT.png | diff BEFORE.png AFTER.png [OUTPUT.png]";

    private static int Number(string arg)
    {
        int value;
        if (!int.TryParse(arg, out value) || value < 0) throw new ArgumentException(Usage);
        return value;
    }

    private static Dictionary<string, object> Command(string[] args)
    {
        if (args.Length == 0) throw new ArgumentException(Usage);
        string action = args[0];
        var command = new Dictionary<string, object> { { "action", action } };
        switch (action)
        {
            case "locate":
                if (args.Length > 2) throw new ArgumentException(Usage);
                if (args.Length == 2) command["value"] = args[1];
                return command;
            case "focus-tab":
                if (args.Length != 3 || String.IsNullOrWhiteSpace(args[2])) throw new ArgumentException(Usage);
                command["value"] = args[2];
                break;
            case "status": case "tabs":
                if (args.Length != 1) throw new ArgumentException(Usage);
                return command;
            case "open":
                if (args.Length != 2 && !(args.Length == 3 && args[2] == "--focus")) throw new ArgumentException(Usage);
                command["url"] = args[1];
                if (args.Length == 2) command["action"] = "open-background";
                else command["focus"] = true;
                return command;
            case "read-start":
                if (args.Length < 2 || args.Length > 3) throw new ArgumentException(Usage);
                if (args.Length == 3) command["value"] = args[2];
                break;
            case "read": case "controls":
                if (args.Length < 2 || args.Length > (action == "read" ? 5 : 3)) throw new ArgumentException(Usage);
                if (args.Length >= 3) command["offset"] = Number(args[2]);
                if (args.Length >= 4) command["documentId"] = args[3];
                if (args.Length == 5) command["snapshotId"] = args[4];
                break;
            case "click": case "fill": case "check": case "select":
                if (args.Length != (action == "click" ? 3 : 4)) throw new ArgumentException(Usage);
                command["ref"] = args[2];
                if (args.Length == 4) command["value"] = args[3];
                break;
            case "scroll":
                if (args.Length != 3 || (args[2] != "up" && args[2] != "down")) throw new ArgumentException(Usage);
                command["direction"] = args[2];
                break;
            case "select-text":
                if (args.Length != 3 && args.Length != 4) throw new ArgumentException(Usage);
                command["value"] = args[2];
                if (args.Length == 4) command["occurrence"] = Number(args[3]);
                break;
            case "wait":
                if (args.Length < 3) throw new ArgumentException(Usage);
                command["condition"] = args[2];
                bool ready = args[2] == "ready";
                if (!ready && args[2] != "text" && args[2] != "gone") throw new ArgumentException(Usage);
                int required = ready ? 3 : 4;
                if (args.Length != required && args.Length != required + 1) throw new ArgumentException(Usage);
                if (!ready) command["value"] = args[3];
                if (args.Length > required) command["timeoutMs"] = Number(args[required]);
                break;
            case "screenshot":
                if (args.Length != 3) throw new ArgumentException(Usage);
                // The destination is local to this CLI and is never sent to Chrome.
                break;
            default: throw new ArgumentException(Usage);
        }
        command["tabId"] = Number(args[1]);
        return command;
    }

    private static string PipeTimeoutCode()
    {
        try
        {
            Mutex marker;
            if (!Mutex.TryOpenExisting(HostMutex, MutexRights.Synchronize, out marker)) return "BRIDGE_OFFLINE";
            marker.Dispose();
            return "BRIDGE_BUSY";
        }
        catch (UnauthorizedAccessException) { return "BRIDGE_ACCESS_DENIED"; }
    }

    private static bool IsPipeWaitTimeout(Exception error)
    {
        if (error is TimeoutException) return true;
        // .NET Framework can surface WaitNamedPipe's ERROR_SEM_TIMEOUT or ERROR_PIPE_BUSY as IOException.
        return error is IOException && (error.HResult == unchecked((int)0x80070079) ||
                                        error.HResult == unchecked((int)0x800700E7));
    }

    private static void Connect(NamedPipeClientStream pipe, string action)
    {
        try { pipe.Connect(3500); return; }
        catch (Exception error)
        {
            if (!IsPipeWaitTimeout(error) || !QueuedReads.Contains(action) || PipeTimeoutCode() != "BRIDGE_BUSY") throw;
        }
        // Wait for the current command to finish. No command has been sent yet.
        pipe.Connect(8500);
    }

    private static int Client(string[] args)
    {
        Dictionary<string, object> command;
        string destination = null;
        try
        {
            if (args.Length > 0 && args[0] == "diff")
            {
                if (args.Length != 3 && args.Length != 4) throw new ArgumentException(Usage);
                var result = PngFiles.Compare(args[1], args[2], args.Length == 4 ? args[3] : null);
                Console.WriteLine(Json(new { ok = true, data = result }));
                return 0;
            }
            command = Command(args);
            if (args[0] == "screenshot") destination = PngFiles.Destination(args[2]);
        }
        catch (ArgumentException)
        {
            Console.WriteLine(Json(new { ok = false, error = "USAGE", detail = Usage }));
            return 2;
        }
        catch (Exception error) { return ImageError(error); }
        using (var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
        {
            bool connected = false;
            try
            {
                Connect(pipe, args[0]);
                connected = true;
                WriteFrame(pipe, Json(command));
                string reply = ReadFrame(pipe, 21000, ReplyLimit);
                var response = Parse(reply);
                bool ok = Object.Equals(response["ok"], true);
                if (ok && destination != null)
                {
                    try
                    {
                        var data = (Dictionary<string, object>)response["data"];
                        var file = PngFiles.SaveViewport(destination, (string)data["png"], (string)data["url"]);
                        Console.WriteLine(Json(new { ok = true, data = file }));
                        return 0;
                    }
                    catch (Exception error) { return ImageError(error); }
                }
                if (!ok && Object.Equals(response["error"], "UNKNOWN_ACTION") &&
                    (args[0] == "open" || args[0] == "locate" || args[0] == "focus-tab" || args[0] == "read-start" || args[0] == "wait" || args[0] == "select-text" || args[0] == "screenshot"))
                    reply = Json(new { ok = false, error = "EXTENSION_RELOAD_REQUIRED" });
                Console.WriteLine(reply);
                return ok ? 0 : 1;
            }
            catch (Exception error)
            {
                Exception cause = error.GetBaseException();
                string code = connected ? "OUTCOME_UNKNOWN" :
                    cause is UnauthorizedAccessException ? "BRIDGE_ACCESS_DENIED" :
                    IsPipeWaitTimeout(cause) ? PipeTimeoutCode() : "BRIDGE_CONNECTION_ERROR";
                Console.WriteLine(Json(new { ok = false, error = code, detail = cause.Message }));
                return 1;
            }
        }
    }

    private static int ImageError(Exception error)
    {
        string code = error is InvalidDataException ? error.Message : "IMAGE_FILE_ERROR";
        Console.WriteLine(Json(new { ok = false, error = code, detail = error.GetBaseException().Message }));
        return 1;
    }

    internal static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == Origin)
        {
            try { return Host(); }
            catch (Exception error)
            {
                WriteFrame(Console.OpenStandardOutput(), Json(new { type = "error", error = error.GetBaseException().Message }));
                return 1;
            }
        }
        Console.OutputEncoding = Utf8;
        if (args.Length == 1 && args[0] == "--args-json")
        {
            try
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), Utf8))
                    args = new JavaScriptSerializer().Deserialize<string[]>(reader.ReadToEnd());
                if (args == null) throw new InvalidDataException();
            }
            catch (Exception)
            {
                Console.WriteLine(Json(new { ok = false, error = "USAGE", detail = Usage }));
                return 2;
            }
        }
        return Client(args);
    }
}
