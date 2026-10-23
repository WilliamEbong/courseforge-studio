// Windows platform rasterization only; original native media stays in the archive.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $source = New-Object System.IO.MemoryStream(,$bytes)
  $image = [System.Drawing.Image]::FromStream($source)
  if ($image.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Emf.Guid) { throw 'Not EMF' }
  $w = $image.Width; $h = $image.Height
  if ($w -lt 1 -or $h -lt 1 -or $w -gt 8192 -or $h -gt 8192 -or [long]$w * $h -gt 16777216) { throw 'Image bounds' }
  $bitmap = New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawImage($image,0,0,$w,$h)
  $output = New-Object System.IO.MemoryStream
  $bitmap.Save($output,[System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Write([Convert]::ToBase64String($output.ToArray()))
} catch { [Console]::Error.Write('EMF conversion failed or exceeded image bounds'); exit 1 }
finally { foreach ($resource in @($graphics,$bitmap,$image,$source,$output)) { if ($null -ne $resource) { $resource.Dispose() } } }
`;
const encoded = Buffer.from(script, 'utf16le').toString('base64');
const cache = new Map();
let cachedBytes = 0;

export function emfToPng(data) {
  if (process.platform !== 'win32') throw new Error('EMF rasterization requires Windows');
  if (data.length < 88 || data.length > 16 * 1024 * 1024) throw new Error('invalid or oversized EMF data');
  const key = crypto.createHash('sha256').update(data).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: data.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 96 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Windows EMF conversion failed, timed out, or exceeded image bounds');
  const png = Buffer.from(result.stdout.trim(), 'base64');
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Windows EMF conversion returned no PNG');
  // Repeated native load/verify calls share unchanged rasterizations, bounded to 32 MiB.
  if (cachedBytes + png.length > 32 * 1024 * 1024) { cache.clear(); cachedBytes = 0; }
  if (png.length <= 32 * 1024 * 1024) { cache.set(key, png); cachedBytes += png.length; }
  return png;
}
