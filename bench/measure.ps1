# Measures time-to-window and memory for a desktop app (Tauri or Electron).
#
#   Tauri:    .\bench\measure.ps1 -Exe src-tauri\target\release\snake-tauri.exe
#   Electron: .\bench\measure.ps1 -Exe bench\electron\node_modules\electron\dist\electron.exe -AppArgs bench\electron
#
# Time-to-window = Start-Process until a visible, titled top-level window exists.
# Memory = launched process + all descendants, sampled $SettleSec after the last launch.
param(
  [Parameter(Mandatory)] [string]$Exe,
  [string]$AppArgs = "",
  [int]$Runs = 5,
  [int]$SettleSec = 8
)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BenchWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
}
"@
function Test-Window([int]$procId) {
  $script:hit = $false
  [BenchWin]::EnumWindows({ param($h, $l) $p = 0; [void][BenchWin]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $procId -and [BenchWin]::IsWindowVisible($h) -and [BenchWin]::GetWindowTextLength($h) -gt 0) { $script:hit = $true; return $false }
    return $true }, [IntPtr]::Zero) | Out-Null
  $script:hit
}
function Get-Tree([int]$rootId) {
  $all = Get-CimInstance Win32_Process
  $ids = @($rootId); $frontier = @($rootId)
  while ($frontier.Count) { $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object ProcessId); $ids += $next; $frontier = $next }
  $all | Where-Object { $ids -contains $_.ProcessId }
}

# Private WebView2 profile: otherwise a Tauri app can attach to the WebView2
# processes of another running instance and the memory numbers get mixed up.
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:TEMP "snake-bench-wv2"

$exePath = (Resolve-Path $Exe).Path
$times = @()
for ($i = 1; $i -le $Runs; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = if ($AppArgs) { Start-Process -FilePath $exePath -ArgumentList "`"$((Resolve-Path $AppArgs).Path)`"" -PassThru }
       else { Start-Process -FilePath $exePath -PassThru }
  while (-not (Test-Window $p.Id)) { Start-Sleep -Milliseconds 10; if ($sw.ElapsedMilliseconds -gt 20000) { break } }
  $sw.Stop(); $times += $sw.ElapsedMilliseconds
  if ($i -eq $Runs) {
    Start-Sleep -Seconds $SettleSec
    $procs = Get-Tree $p.Id | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    $memory = "processes={0}  working_set={1:N1} MB  private={2:N1} MB" -f $procs.Count,
      (($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB), (($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB)
  }
  Get-Tree $p.Id | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 1500
}
"time_to_window_ms = " + ($times -join ', ') + "   (median " + (($times | Sort-Object)[[int][math]::Floor($Runs / 2)]) + ")"
$memory
