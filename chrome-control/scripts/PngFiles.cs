using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

internal static class PngFiles
{
    private const long MaxPixels = 32L * 1024 * 1024;
    private const string Prefix = "data:image/png;base64,";

    internal static string Destination(string path)
    {
        string full = Path.GetFullPath(path);
        if (!String.Equals(Path.GetExtension(full), ".png", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("PNG_PATH_REQUIRED");
        if (File.Exists(full)) throw new InvalidDataException("OUTPUT_EXISTS");
        if (!Directory.Exists(Path.GetDirectoryName(full))) throw new InvalidDataException("OUTPUT_DIRECTORY_MISSING");
        return full;
    }

    private static void SaveNew(string path, Action<Stream> write)
    {
        string stage = Path.Combine(Path.GetDirectoryName(path), Guid.NewGuid().ToString("N") + ".tmp");
        var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        try
        {
            using (stream) { write(stream); }
            File.Move(stage, path);
        }
        catch (IOException)
        {
            if (File.Exists(path)) throw new InvalidDataException("OUTPUT_EXISTS");
            throw;
        }
        finally { if (File.Exists(stage)) File.Delete(stage); }
    }

    private static int BigEndian(byte[] data, int start)
    {
        return data[start] << 24 | data[start + 1] << 16 | data[start + 2] << 8 | data[start + 3];
    }

    private static Size Dimensions(byte[] header)
    {
        if (header.Length < 24 || BigEndian(header, 0) != unchecked((int)0x89504e47) ||
            BigEndian(header, 4) != 0x0d0a1a0a || BigEndian(header, 8) != 13 || BigEndian(header, 12) != 0x49484452)
            throw new InvalidDataException("INVALID_PNG");
        int width = BigEndian(header, 16), height = BigEndian(header, 20);
        if (width <= 0 || height <= 0 || (long)width * height > MaxPixels)
            throw new InvalidDataException("INVALID_IMAGE_SIZE");
        return new Size(width, height);
    }

    internal static object SaveViewport(string path, string dataUrl, string url)
    {
        if (dataUrl == null || !dataUrl.StartsWith(Prefix, StringComparison.Ordinal))
            throw new InvalidDataException("INVALID_PNG");
        byte[] png = Convert.FromBase64String(dataUrl.Substring(Prefix.Length));
        Size size = Dimensions(png);
        if (png.Length < 45 || BigEndian(png, png.Length - 12) != 0 || BigEndian(png, png.Length - 8) != 0x49454e44)
            throw new InvalidDataException("INVALID_PNG");
        SaveNew(path, stream => stream.Write(png, 0, png.Length));
        return new { path = path, url = url, width = size.Width, height = size.Height, bytes = png.Length };
    }

    private static Bitmap LoadPixels(string path)
    {
        using (var file = File.OpenRead(path))
        using (var reader = new BinaryReader(file))
        {
            Size size = Dimensions(reader.ReadBytes(24));
            file.Position = 0;
            using (var original = new Bitmap(file))
            {
                var copy = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
                try
                {
                    using (var graphics = Graphics.FromImage(copy))
                    {
                        graphics.CompositingMode = CompositingMode.SourceCopy;
                        graphics.DrawImageUnscaled(original, 0, 0);
                    }
                    return copy;
                }
                catch { copy.Dispose(); throw; }
            }
        }
    }

    internal static object Compare(string firstPath, string secondPath, string output)
    {
        if (output != null) output = Destination(output);
        using (var before = LoadPixels(firstPath))
        using (var after = LoadPixels(secondPath))
        {
            if (before.Size != after.Size) throw new InvalidDataException("IMAGE_SIZE_MISMATCH");
            int width = after.Width, height = after.Height;
            var area = new Rectangle(0, 0, width, height);
            int left = width, top = height, right = -1, bottom = -1;
            long changed = 0;
            var previous = new int[width];
            var latest = new int[width];
            var first = before.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var second = after.LockBits(area, output == null ? ImageLockMode.ReadOnly : ImageLockMode.ReadWrite,
                    PixelFormat.Format32bppArgb);
                try
                {
                    for (int y = 0; y < height; y++)
                    {
                        var row = IntPtr.Add(second.Scan0, y * second.Stride);
                        Marshal.Copy(IntPtr.Add(first.Scan0, y * first.Stride), previous, 0, width);
                        Marshal.Copy(row, latest, 0, width);
                        for (int x = 0; x < width; x++)
                        {
                            if (previous[x] == latest[x]) continue;
                            changed++;
                            left = Math.Min(left, x);
                            right = Math.Max(right, x);
                            top = Math.Min(top, y);
                            bottom = y;
                            latest[x] = unchecked((int)0xffff0080);
                        }
                        if (output != null) Marshal.Copy(latest, 0, row, width);
                    }
                }
                finally { after.UnlockBits(second); }
            }
            finally { before.UnlockBits(first); }
            if (output != null) SaveNew(output, stream => after.Save(stream, ImageFormat.Png));
            var bounds = changed == 0 ? null : new { x = left, y = top, width = right - left + 1, height = bottom - top + 1 };
            return new { equal = changed == 0, changedPixels = changed, totalPixels = (long)width * height,
                width = width, height = height, bounds = bounds, path = output };
        }
    }
}
