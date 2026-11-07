// Wireless screen mirroring inputs (AirPlay, Google Cast, Miracast).
// SGC Songs doesn't receive these itself - a receiver app on this PC does, and its mirroring window
// is captured like any other window:
// - AirServer: AirPlay + Google Cast + Miracast in one app (recommended)
// - UxPlay: open-source AirPlay mirroring receiver
// - Wireless Display: Windows' own Miracast receiver ("Projecting to this PC")
// This finds which capturable windows belong to those apps, so they can be listed by device.

import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import { desktopCapturer, shell } from "electron"
import fs from "fs"
import path from "path"

export type WirelessReceiver = "AirServer" | "UxPlay" | "Wireless Display"
// the receiver window's frame (title bar, borders) as fractions of the captured image - cropped off on output
export type WindowCrop = { top: number; left: number; right: number; bottom: number }
export type WirelessSource = { id: string; name: string; receiver: WirelessReceiver; crop?: WindowCrop }
type ListedWindow = { hwnd: number; title: string; process: string; width: number; height: number; top?: number; left?: number; right?: number; bottom?: number }

const isWindows = process.platform === "win32"

export function receiverOf(win: Pick<ListedWindow, "title" | "process">): WirelessReceiver | null {
    const proc = (win.process || "").toLowerCase()
    const title = (win.title || "").trim()
    if (proc.startsWith("airserver")) return "AirServer"
    // the uxplay-windows package runs the receiver inside its own app (uxplay-windows.exe)
    if (proc === "uxplay" || proc === "uxplay-windows" || /^uxplay\b/i.test(title)) return "UxPlay"
    // UWP app, its window is hosted by ApplicationFrameHost - recognised by its title
    if (/^(wireless display|connect)$/i.test(title)) return "Wireless Display"
    return null
}

// a receiver's small settings/tray windows aren't mirroring sessions
const MIN_SIZE = 200

export async function getWirelessSources(): Promise<WirelessSource[]> {
    let sources: Electron.DesktopCapturerSource[] = []
    try {
        sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } })
    } catch (err) {
        console.error("Could not list windows:", err)
        return []
    }

    if (!isWindows) {
        // no process info here - fall back to the window titles
        return sources.flatMap((source) => {
            const receiver = receiverOf({ title: source.name, process: /airserver/i.test(source.name) ? "airserver" : "" })
            return receiver ? [{ id: source.id, name: source.name, receiver }] : []
        })
    }

    const windows = await listWindows()
    const byHwnd = new Map(windows.map((w) => [w.hwnd, w]))

    return sources.flatMap((source) => {
        // Windows capture ids are "window:<HWND>:0"
        const hwnd = Number(source.id.split(":")[1])
        const win = byHwnd.get(hwnd)
        if (!win || win.width < MIN_SIZE || win.height < MIN_SIZE) return []

        const receiver = receiverOf(win)
        if (!receiver) return []
        return [{ id: source.id, name: win.title || source.name || receiver, receiver, crop: windowCrop(win) }]
    })
}

export function windowCrop(win: ListedWindow): WindowCrop | undefined {
    if (!win.width || !win.height || win.top === undefined) return undefined
    const fraction = (px: number | undefined, size: number) => Math.min(0.4, Math.max(0, (px || 0) / size))
    return { top: fraction(win.top, win.height), left: fraction(win.left, win.width), right: fraction(win.right, win.width), bottom: fraction(win.bottom, win.height) }
}

// ----- WINDOW LIST (Windows) -----
// One PowerShell stays running in the background (compiling the helper takes a second, every
// later list is instant), started the first time the inputs are opened.

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class SgcWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public struct RECT { public int L, T, R, B; }
  public static List<object[]> List() {
    // per-monitor DPI aware, so frame and client coordinates are both in real pixels on scaled displays
    SetProcessDpiAwarenessContext((IntPtr)(-4));
    var list = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      // the visible frame (without the invisible resize borders) is what window capture records
      RECT r; if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
      RECT c; GetClientRect(h, out c); POINT p = new POINT(); ClientToScreen(h, ref p);
      list.Add(new object[] { h.ToInt64(), sb.ToString(), pid, r.R - r.L, r.B - r.T, p.Y - r.T, p.X - r.L, r.R - (p.X + c.R), r.B - (p.Y + c.B) });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $names = @{}
  Get-Process | ForEach-Object { $names[[uint32]$_.Id] = $_.ProcessName }
  $out = [SgcWindows]::List() | ForEach-Object { @{ hwnd = $_[0]; title = $_[1]; process = $names[[uint32]$_[2]]; width = $_[3]; height = $_[4]; top = $_[5]; left = $_[6]; right = $_[7]; bottom = $_[8] } }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 @($out)))
  [Console]::Out.WriteLine('__END__')
}
`

let shellProcess: ChildProcessWithoutNullStreams | null = null
let buffer = ""
let waiting: ((windows: ListedWindow[]) => void)[] = []

function startShell() {
    if (shellProcess) return shellProcess
    // the script goes in as -EncodedCommand (stdin is kept for the list requests only)
    const encoded = Buffer.from(LIST_SCRIPT, "utf16le").toString("base64")
    shellProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true })

    shellProcess.stdout.setEncoding("utf8")
    shellProcess.stdout.on("data", (chunk: string) => {
        buffer += chunk
        let end = buffer.indexOf("__END__")
        while (end > -1) {
            const json = buffer.slice(0, end).trim()
            buffer = buffer.slice(end + "__END__".length)
            let windows: ListedWindow[] = []
            try {
                windows = json ? JSON.parse(json) : []
            } catch (err) {
                console.error("Wireless sources: could not read window list", err)
            }
            waiting.shift()?.(Array.isArray(windows) ? windows : [])
            end = buffer.indexOf("__END__")
        }
    })
    shellProcess.on("exit", () => {
        shellProcess = null
        buffer = ""
        waiting.splice(0).forEach((resolve) => resolve([]))
    })

    return shellProcess
}

function listWindows(): Promise<ListedWindow[]> {
    return new Promise((resolve) => {
        const proc = startShell()
        const timeout = setTimeout(() => {
            const index = waiting.indexOf(done)
            if (index > -1) waiting.splice(index, 1)
            resolve([])
        }, 8000)
        function done(windows: ListedWindow[]) {
            clearTimeout(timeout)
            resolve(windows)
        }
        waiting.push(done)
        proc.stdin.write("list\r\n")
    })
}

export function stopWirelessSources() {
    shellProcess?.kill()
    shellProcess = null
}

// ----- OPEN A RECEIVER -----

const AIRSERVER_PATHS = [path.join(process.env.ProgramFiles || "C:\\Program Files", "App Dynamic", "AirServer", "AirServer.exe"), path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "App Dynamic", "AirServer", "AirServer.exe")]

export function openWirelessReceiver(receiver: WirelessReceiver) {
    if (receiver === "AirServer") {
        const exe = AIRSERVER_PATHS.find((p) => fs.existsSync(p))
        if (exe) return shell.openPath(exe)
        return shell.openExternal("https://www.airserver.com/Windows")
    }
    if (receiver === "Wireless Display") {
        // Windows settings page to turn on / open "Projecting to this PC" (Miracast receiver)
        return shell.openExternal("ms-settings:project")
    }
    return shell.openExternal("https://github.com/FDH2/UxPlay")
}
