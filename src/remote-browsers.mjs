import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BROWSER_NAMES = new Set([
  "chrome.exe", "msedge.exe", "thorium.exe", "chromium.exe", "brave.exe",
  "vivaldi.exe", "opera.exe", "yandex.exe", "arc.exe", "coccoc.exe", "whale.exe",
  "firefox.exe", "librewolf.exe", "waterfox.exe", "floorp.exe", "zen.exe",
]);

function isFirefoxFamily(processName) {
  return /firefox|librewolf|waterfox|floorp|zen/i.test(processName);
}

function browserLabel(processName) {
  const name = processName.toLowerCase();
  if (name.includes("firefox")) return "Firefox";
  if (name.includes("librewolf")) return "LibreWolf";
  if (name.includes("waterfox")) return "Waterfox";
  if (name.includes("floorp")) return "Floorp";
  if (name.includes("zen")) return "Zen Browser";
  if (name.includes("thorium")) return "Thorium";
  if (name.includes("edge")) return "Microsoft Edge";
  if (name.includes("brave")) return "Brave";
  if (name.includes("vivaldi")) return "Vivaldi";
  if (name.includes("opera")) return "Opera";
  if (name.includes("yandex")) return "Yandex Browser";
  if (name.includes("arc")) return "Arc";
  if (name.includes("coccoc")) return "Coc Coc";
  if (name.includes("whale")) return "Naver Whale";
  if (name.includes("chromium")) return "Chromium";
  return "Google Chrome";
}

async function readBrowserProcesses() {
  if (process.platform === "win32") {
    const script = String.raw`$names = @('chrome.exe','msedge.exe','thorium.exe','chromium.exe','brave.exe','vivaldi.exe','opera.exe','yandex.exe','arc.exe','coccoc.exe','whale.exe','firefox.exe','librewolf.exe','waterfox.exe','floorp.exe','zen.exe'); Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name.ToLower() } | ForEach-Object { $commandLine = $_.CommandLine; if ($commandLine -match '--remote-debugging-port(?:=|\s+)(\d{1,5})') { [pscustomobject]@{ name = $_.Name; port = [int]$Matches[1] } } } | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 4_000,
        maxBuffer: 64 * 1024,
      });
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout);
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) =>
        BROWSER_NAMES.has(String(item.name).toLowerCase()) && Number.isInteger(item.port) && item.port >= 1 && item.port <= 65_535,
      );
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "comm=,args="], { timeout: 2_000, maxBuffer: 1024 * 1024 });
    const found = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/(?:^|\/)(chrome|msedge|thorium|chromium|brave|vivaldi|opera|yandex|arc|coccoc|whale|firefox|librewolf|waterfox|floorp|zen)(?:-browser)?(?:\.exe)?\s+.*?--remote-debugging-port(?:=|\s+)(\d{1,5})/i);
      if (match) found.push({ name: `${match[1]}.exe`, port: Number(match[2]) });
    }
    return found.filter((item) => item.port > 0 && item.port <= 65_535);
  } catch {
    return [];
  }
}

function localWebSocketUrl(value, expectedPort) {
  const url = new URL(value);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Tarayıcı debug endpoint'i loopback ws:// adresi olmalı.");
  }
  if (Number(url.port) !== expectedPort || url.username || url.password) {
    throw new Error("Tarayıcı endpoint portu beklenen yerel porta uymuyor.");
  }
  return url.toString();
}

async function fetchJson(url, timeoutMs = 1_000) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function discoverRemoteBrowsers() {
  const processes = await readBrowserProcesses();
  const unique = new Map();
  for (const processInfo of processes) {
    const key = `${processInfo.name.toLowerCase()}:${processInfo.port}`;
    if (unique.has(key)) continue;
    const firefox = isFirefoxFamily(processInfo.name);
    const candidate = {
      id: `${firefox ? "firefox" : "chromium"}:${processInfo.port}`,
      browser: browserLabel(processInfo.name),
      protocol: firefox ? "webDriverBiDi" : "cdp",
      port: processInfo.port,
    };

    try {
      if (firefox) {
        await fetchJson(`http://127.0.0.1:${processInfo.port}/status`);
      } else {
        const version = await fetchJson(`http://127.0.0.1:${processInfo.port}/json/version`);
        candidate.version = String(version.Browser || "Chromium").slice(0, 100);
        localWebSocketUrl(version.webSocketDebuggerUrl, processInfo.port);
      }
      unique.set(key, candidate);
    } catch {
      // Process flags can outlive the listener briefly or point at a restarting browser.
    }
  }
  return [...unique.values()];
}

export async function connectRemoteBrowser({ protocol, port }) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Geçersiz debug portu.");
  let endpoint;
  if (protocol === "cdp") {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    endpoint = localWebSocketUrl(version.webSocketDebuggerUrl, port);
  } else if (protocol === "webDriverBiDi") {
    const status = await fetchJson(`http://127.0.0.1:${port}/status`);
    if (status.value?.ready === false) throw new Error("Firefox Remote Agent henüz hazır değil.");
    endpoint = `ws://127.0.0.1:${port}/session`;
  } else {
    throw new Error("Desteklenmeyen browser protocol.");
  }
  return { endpoint, protocol };
}
