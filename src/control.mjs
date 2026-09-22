import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_FILE = path.join(ROOT, "src", "server.mjs");
const APP_NAME = "local-browser-mcp";
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const APP_DATA_DIR = process.env.BROWSER_MCP_DATA_DIR || path.join(LOCAL_APP_DATA, APP_NAME);
const TOKEN_PATH = path.join(APP_DATA_DIR, "token");
const PID_PATH = path.join(APP_DATA_DIR, "server.pid");
const URL = `http://127.0.0.1:${process.env.BROWSER_MCP_PORT || "7331"}`;
const MCP_URL = `${URL}/mcp`;
const STARTUP_NAME = "LocalBrowserMcp";
const HOME_DIR = os.homedir();
const CODEX_CONFIG_PATH = path.join(HOME_DIR, ".codex", "config.toml");
const OPENCODE_CONFIG_PATH = path.join(HOME_DIR, ".config", "opencode", "opencode.json");
const OPENCODE_JSONC_PATH = path.join(HOME_DIR, ".config", "opencode", "opencode.jsonc");
const COMMAND_CODE_CONFIG_PATH = path.join(HOME_DIR, ".commandcode", "mcp.json");
const COMMAND_CODE_CLI_PATH = path.join(
  process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming"),
  "npm",
  "node_modules",
  "command-code",
  "dist",
  "index.mjs",
);

const ansi = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function readToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  const token = readFileSync(TOKEN_PATH, "utf8").trim();
  return token || null;
}

function readTextSafe(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(filePath) {
  const text = readTextSafe(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const jsonc = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(jsonc);
    } catch {
      return null;
    }
  }
}

function commandAvailable(command) {
  if (path.isAbsolute(command)) return existsSync(command);
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function commandCodeCommand() {
  return existsSync(COMMAND_CODE_CLI_PATH)
    ? [process.execPath, COMMAND_CODE_CLI_PATH]
    : ["commandcode"];
}

function codexConfigured() {
  const text = readTextSafe(CODEX_CONFIG_PATH) || "";
  const section = text.match(/(?:^|\n)\[mcp_servers\.(?:local-browser|local_browser)\]([^\[]*)/m)?.[1] || "";
  return section.includes(MCP_URL);
}

function openCodeConfig() {
  return readJsonSafe(OPENCODE_CONFIG_PATH) || readJsonSafe(OPENCODE_JSONC_PATH);
}

function openCodeConfigured() {
  const config = openCodeConfig();
  const direct = config?.mcp?.["local-browser"] || config?.mcp?.local_browser;
  const v2 = config?.mcp?.servers?.["local-browser"] || config?.mcp?.servers?.local_browser;
  return Boolean((direct || v2) && JSON.stringify(direct || v2).includes(MCP_URL));
}

function commandCodeConfigured() {
  const config = readJsonSafe(COMMAND_CODE_CONFIG_PATH);
  const entry = config?.mcpServers?.["local-browser"] || config?.mcpServers?.local_browser;
  return Boolean(entry && JSON.stringify(entry).includes(MCP_URL));
}

function runClientCommand(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const token = readToken();
    const message = (result.stderr || result.stdout || "MCP kurulumu basarisiz.").trim();
    throw new Error(token ? message.replaceAll(token, "[redacted]") : message);
  }
}

function ensureTokenEnvironment() {
  const token = readToken();
  if (!token) throw new Error("MCP token bulunamadi; once MCP'yi baslatin.");
  process.env.BROWSER_MCP_TOKEN = token;
  if (process.platform === "win32") {
    runPowerShell(
      "$value=$env:LOCAL_BROWSER_MCP_TOKEN; [Environment]::SetEnvironmentVariable('BROWSER_MCP_TOKEN',$value,'User')",
      { LOCAL_BROWSER_MCP_TOKEN: token },
    );
  }
}

const AGENTS = [
  {
    key: "codex",
    name: "Codex",
    installed: () => commandAvailable("codex"),
    configured: codexConfigured,
    install: () => runClientCommand("codex", [
      "mcp", "add", "local-browser", "--url", MCP_URL,
      "--bearer-token-env-var", "BROWSER_MCP_TOKEN",
    ]),
  },
  {
    key: "opencode",
    name: "OpenCode",
    installed: () => commandAvailable("opencode"),
    configured: openCodeConfigured,
    install: () => runClientCommand("opencode", [
      "mcp", "add", "local-browser", "--url", MCP_URL,
      "--header", "Authorization=Bearer {env:BROWSER_MCP_TOKEN}",
    ]),
  },
  {
    key: "commandcode",
    name: "CommandCode",
    installed: () => commandAvailable(commandCodeCommand()[0]) || existsSync(COMMAND_CODE_CLI_PATH),
    configured: commandCodeConfigured,
    install: () => {
      const [executable, ...prefix] = commandCodeCommand();
      runClientCommand(executable, [
        ...prefix, "mcp", "add", "--transport", "http", "--scope", "user",
        "--header", "Authorization: Bearer ${BROWSER_MCP_TOKEN}",
        "local-browser", MCP_URL,
      ]);
    },
  },
];

function agentStatuses() {
  return AGENTS.map((agent) => ({
    key: agent.key,
    name: agent.name,
    installed: agent.installed(),
    configured: agent.configured(),
  }));
}

function agentStatusText() {
  const lines = agentStatuses().map((agent) => {
    let label;
    if (!agent.installed) label = `${ansi.red}x istemci kurulu degil${ansi.reset}`;
    else if (agent.configured) label = `${ansi.green}● MCP kurulu${ansi.reset}`;
    else label = `${ansi.yellow}○ MCP eksik${ansi.reset}`;
    return `  ${agent.name.padEnd(12)} ${label}`;
  });
  return `${ansi.cyan}${ansi.bold}MCP istemci baglantilari${ansi.reset}\n${lines.join("\n")}`;
}

function installMissingAgents() {
  ensureTokenEnvironment();
  const statuses = agentStatuses();
  const missing = statuses.filter((agent) => agent.installed && !agent.configured);
  if (!missing.length) {
    console.log(`${ansi.green}Kurulu istemcilerde MCP zaten kurulu.${ansi.reset}`);
    return;
  }
  for (const agent of missing) {
    const definition = AGENTS.find((item) => item.key === agent.key);
    try {
      definition.install();
      console.log(`${ansi.green}${agent.name}: MCP kuruldu.${ansi.reset}`);
    } catch (error) {
      console.log(`${ansi.red}${agent.name}: ${error instanceof Error ? error.message : error}${ansi.reset}`);
    }
  }
}

async function health() {
  const token = readToken();
  if (!token) return null;
  try {
    const response = await fetch(`${URL}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await health();
    if (current) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function mcpHeaders(token, sessionId) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
  };
}

async function parseMcpResponse(response) {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const events = text
      .split(/\r?\n\r?\n/)
      .flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()))
      .filter(Boolean);
    return events.length ? JSON.parse(events.at(-1)) : null;
  }
  return JSON.parse(text);
}

async function callTool(name, arguments_ = {}) {
  const token = readToken();
  if (!token) throw new Error("Token henüz oluşturulmadı; önce sunucuyu başlatın.");
  const initialize = await fetch(MCP_URL, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "local-browser-mcp-control", version: "0.1.0" },
      },
    }),
  });
  if (!initialize.ok) throw new Error(`MCP initialize başarısız (${initialize.status}).`);
  const sessionId = initialize.headers.get("mcp-session-id");
  await parseMcpResponse(initialize);

  try {
    await fetch(MCP_URL, {
      method: "POST",
      headers: mcpHeaders(token, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: mcpHeaders(token, sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    });
    if (!response.ok) throw new Error(`MCP tool çağrısı başarısız (${response.status}).`);
    const result = await parseMcpResponse(response);
    if (result?.error) throw new Error(result.error.message || "MCP tool hatası.");
    return result;
  } finally {
    if (sessionId) {
      await fetch(MCP_URL, {
        method: "DELETE",
        headers: mcpHeaders(token, sessionId),
      }).catch(() => {});
    }
  }
}

function runPowerShell(script, environment = {}) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...environment },
    },
  );
  if (result.status !== 0) throw new Error((result.stderr || "PowerShell işlemi başarısız.").trim());
  return (result.stdout || "").trim();
}

function startupCommand() {
  const nodew = process.execPath.toLowerCase().endsWith("node.exe")
    ? process.execPath.slice(0, -8) + "nodew.exe"
    : process.execPath;
  const executable = existsSync(nodew) ? nodew : process.execPath;
  return `"${executable}" "${SERVER_FILE}" --http`;
}

function startupValue() {
  if (process.platform !== "win32") return null;
  const script = "$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; (Get-ItemProperty -Path $p -Name $env:LOCAL_BROWSER_MCP_STARTUP_NAME -ErrorAction SilentlyContinue).$($env:LOCAL_BROWSER_MCP_STARTUP_NAME)";
  return runPowerShell(script, { LOCAL_BROWSER_MCP_STARTUP_NAME: STARTUP_NAME }) || null;
}

function installStartup() {
  if (process.platform !== "win32") throw new Error("Otomatik başlatma menüsü bu sürümde yalnızca Windows içindir.");
  const script = "$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; New-Item -Path $p -Force | Out-Null; Set-ItemProperty -Path $p -Name $env:LOCAL_BROWSER_MCP_STARTUP_NAME -Value $env:LOCAL_BROWSER_MCP_STARTUP_VALUE";
  runPowerShell(script, {
    LOCAL_BROWSER_MCP_STARTUP_NAME: STARTUP_NAME,
    LOCAL_BROWSER_MCP_STARTUP_VALUE: startupCommand(),
  });
}

function disableStartup() {
  if (process.platform !== "win32") throw new Error("Otomatik başlatma menüsü bu sürümde yalnızca Windows içindir.");
  const script = "$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Remove-ItemProperty -Path $p -Name $env:LOCAL_BROWSER_MCP_STARTUP_NAME -ErrorAction SilentlyContinue";
  runPowerShell(script, { LOCAL_BROWSER_MCP_STARTUP_NAME: STARTUP_NAME });
}

function pidFromFile() {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function startServer() {
  const current = await health();
  if (current) return current;
  const child = spawn(process.execPath, [SERVER_FILE, "--http"], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const started = await waitForHealth();
  if (!started) throw new Error("Sunucu 8 saniye içinde hazır olmadı.");
  return started;
}

async function stopServer() {
  const current = await health();
  if (current) await callTool("browser_close").catch(() => {});
  const pid = pidFromFile() || current?.pid;
  if (pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
  }
  try {
    if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
  } catch {
    // A stale PID file is harmless.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return !(await health());
}

async function openVisibleBrowser() {
  await startServer();
  await callTool("browser_start", { headless: false });
}

async function spin(label, action) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;
  process.stdout.write(`${label} `);
  const timer = setInterval(() => {
    process.stdout.write(`\r${label} ${frames[index++ % frames.length]}`);
  }, 90);
  try {
    return await action();
  } finally {
    clearInterval(timer);
    process.stdout.write(`\r${label} ${ansi.green}✓${ansi.reset}\n`);
  }
}

function statusLine(current) {
  const mcp = current ? `${ansi.green}● aktif${ansi.reset}` : `${ansi.red}○ kapalı${ansi.reset}`;
  const browser = current?.browserActive ? `${ansi.green}görünür tarayıcı açık${ansi.reset}` : `${ansi.dim}tarayıcı beklemede${ansi.reset}`;
  const startup = startupValue() ? `${ansi.green}otomatik başlatma açık${ansi.reset}` : `${ansi.yellow}otomatik başlatma kapalı${ansi.reset}`;
  return `MCP: ${mcp}   Tarayıcı: ${browser}   Başlangıç: ${startup}`;
}

async function liveStatus() {
  if (!input.isTTY) {
    console.log("Canlı durum için etkileşimli terminal gerekir.");
    return;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let running = true;
  const onData = (chunk) => {
    if (chunk.toString().toLowerCase() === "q" || chunk[0] === 27) running = false;
  };
  process.stdin.on("data", onData);
  while (running) {
    const current = await health();
    process.stdout.write(`\x1b[2J\x1b[H${ansi.cyan}${ansi.bold}local-browser-mcp canlı durum${ansi.reset}\n\n${statusLine(current)}\n\n${ansi.dim}Çıkmak için q veya Esc${ansi.reset}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  process.stdin.off("data", onData);
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[2J\x1b[H");
}

async function agentsMenu() {
  if (!input.isTTY) {
    console.log(agentStatusText());
    return;
  }
  let rl = createInterface({ input, output });
  try {
    while (true) {
      process.stdout.write(`\x1b[2J\x1b[H${ansi.cyan}${ansi.bold}local-browser-mcp istemci durumu${ansi.reset}\n\n`);
      console.log(agentStatusText());
      console.log(`\nK  Eksik MCP'leri kur\nQ  Geri\n`);
      const choice = (await rl.question("Secim: ")).trim().toLowerCase();
      if (choice === "q") return;
      if (choice === "k") {
        try {
          installMissingAgents();
        } catch (error) {
          console.log(`${ansi.red}${error instanceof Error ? error.message : error}${ansi.reset}`);
        }
        await rl.question("\nDevam etmek icin Enter...");
      } else {
        console.log(`${ansi.yellow}Gecersiz secim.${ansi.reset}`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
  } finally {
    rl.close();
  }
}

async function runCommand(command) {
  switch (command) {
    case "start":
      await spin("MCP başlatılıyor", startServer);
      return;
    case "stop":
      await spin("MCP durduruluyor", stopServer);
      return;
    case "status":
      console.log(statusLine(await health()));
      return;
    case "agents":
    case "clients":
      console.log(agentStatusText());
      return;
    case "install-agents":
      installMissingAgents();
      return;
    case "token": {
      const token = readToken();
      if (!token) throw new Error("Token henüz oluşturulmadı; önce `browser-mcp.cmd start` çalıştırın.");
      console.log(token);
      return;
    }
    case "browser":
      await spin("Görünür tarayıcı açılıyor", openVisibleBrowser);
      return;
    case "install":
      installStartup();
      console.log(`${ansi.green}Otomatik başlatma kuruldu.${ansi.reset} Dosyalar silinmedi.`);
      return;
    case "uninstall":
    case "remove":
      disableStartup();
      console.log(`${ansi.yellow}Otomatik başlatma kapatıldı.${ansi.reset} Proje, profil ve cookie'ler silinmedi.`);
      return;
    default:
      throw new Error(`Bilinmeyen komut: ${command}`);
  }
}

async function legacyMenu() {
  let rl = createInterface({ input, output });
  try {
    while (true) {
      const current = await health();
      console.clear();
      console.log(`${ansi.cyan}${ansi.bold}╭─ local-browser-mcp ─╮${ansi.reset}`);
      console.log(`│ ${statusLine(current)}`);
      console.log(`${ansi.cyan}╰──────────────────────╯${ansi.reset}\n`);
      console.log("1  MCP sunucusunu başlat");
      console.log("2  MCP sunucusunu durdur");
      console.log("3  Canlı durumu göster  (q ile çık)");
      console.log("4  Görünür tarayıcıyı aç");
      console.log("5  PC açılışında otomatik başlatmayı kur");
      console.log("6  Otomatik başlatmayı kaldır (dosyalar kalır)");
      console.log("0  Çıkış\n");
      const choice = (await rl.question("Seçim: ")).trim();
      try {
        if (choice === "0") return;
        if (choice === "1") await runCommand("start");
        else if (choice === "2") await runCommand("stop");
        else if (choice === "3") {
          rl.close();
          await liveStatus();
          rl = createInterface({ input, output });
          continue;
        } else if (choice === "4") {
          rl.close();
          await agentsMenu();
          rl = createInterface({ input, output });
          continue;
        } else if (choice === "5") await runCommand("browser");
        else if (choice === "6") await runCommand("install");
        else if (choice === "7") await runCommand("uninstall");
        else console.log(`${ansi.yellow}Geçersiz seçim.${ansi.reset}`);
      } catch (error) {
        console.log(`${ansi.red}${error instanceof Error ? error.message : error}${ansi.reset}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  } finally {
    rl.close();
  }
}

async function menu() {
  if (!input.isTTY) {
    await runCommand("status");
    return;
  }
  let rl = createInterface({ input, output });
  try {
    while (true) {
      const current = await health();
      console.clear();
      console.log(`${ansi.cyan}${ansi.bold}local-browser-mcp${ansi.reset}`);
      console.log(statusLine(current));
      console.log(`${ansi.dim}MCP acik kalir; secenekler yalnizca yonetim ve kurulumdur.${ansi.reset}\n`);
      console.log("1  MCP sunucusunu baslat");
      console.log("2  MCP sunucusunu durdur");
      console.log("3  Canli durumu goster  (q ile cik)");
      console.log("4  Agent MCP durumlari ve tek tus kurulum");
      console.log("5  Gorunur tarayiciyi ac");
      console.log("6  PC acilisinda otomatik baslatmayi kur");
      console.log("7  Otomatik baslatmayi kaldir (dosyalar kalir)");
      console.log("0  Cikis\n");
      const choice = (await rl.question("Secim: ")).trim().toLowerCase();
      try {
        if (choice === "0") return;
        if (choice === "1") await runCommand("start");
        else if (choice === "2") await runCommand("stop");
        else if (choice === "3") {
          rl.close();
          await liveStatus();
          rl = createInterface({ input, output });
          continue;
        } else if (choice === "4") {
          rl.close();
          await agentsMenu();
          rl = createInterface({ input, output });
          continue;
        } else if (choice === "5") await runCommand("browser");
        else if (choice === "6") await runCommand("install");
        else if (choice === "7") await runCommand("uninstall");
        else console.log(`${ansi.yellow}Gecersiz secim.${ansi.reset}`);
      } catch (error) {
        console.log(`${ansi.red}${error instanceof Error ? error.message : error}${ansi.reset}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  } finally {
    rl.close();
  }
}

const command = process.argv[2];
(command ? runCommand(command) : menu()).catch((error) => {
  console.error(`${ansi.red}${error instanceof Error ? error.message : error}${ansi.reset}`);
  process.exitCode = 1;
});
