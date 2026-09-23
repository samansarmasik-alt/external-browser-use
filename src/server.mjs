import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createSerialQueue, runRepeatedAction } from "./serial-queue.mjs";

const APP_NAME = "local-browser-mcp";
const HTTP_HOST = "127.0.0.1";
const HTTP_PORT = Number.parseInt(process.env.BROWSER_MCP_PORT ?? "7331", 10);
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const APP_DATA_DIR = process.env.BROWSER_MCP_DATA_DIR || path.join(LOCAL_APP_DATA, APP_NAME);
const PROFILE_DIR = process.env.BROWSER_MCP_PROFILE_DIR || path.join(APP_DATA_DIR, "profile");
const TOKEN_PATH = path.join(APP_DATA_DIR, "token");
const PID_PATH = path.join(APP_DATA_DIR, "server.pid");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 60_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

let context = null;
let activePage = null;
let browserStartPromise = null;
const heldInputs = new WeakMap();
const watchedPages = new WeakSet();

function watchPage(page) {
  if (watchedPages.has(page)) return page;
  watchedPages.add(page);
  page.on("close", () => {
    if (activePage === page) activePage = context?.pages().at(-1) || null;
  });
  return page;
}

function pageHeldInputs(page) {
  let state = heldInputs.get(page);
  if (!state) {
    state = { keys: new Set(), buttons: new Set() };
    heldInputs.set(page, state);
  }
  return state;
}

async function pressKeyDown(page, key) {
  await page.keyboard.down(key);
  pageHeldInputs(page).keys.add(key);
}

async function pressKeyUp(page, key) {
  await page.keyboard.up(key);
  pageHeldInputs(page).keys.delete(key);
}

async function pressMouseDown(page, button, clickCount) {
  await page.mouse.down({ button, clickCount });
  pageHeldInputs(page).buttons.add(button);
}

async function pressMouseUp(page, button) {
  await page.mouse.up({ button });
  pageHeldInputs(page).buttons.delete(button);
}

async function releaseInputs(page) {
  const state = pageHeldInputs(page);
  const released = { keys: [], buttons: [] };
  const errors = [];
  for (const button of [...state.buttons].reverse()) {
    try {
      await pressMouseUp(page, button);
      released.buttons.push(button);
    } catch (error) {
      errors.push(`mouse ${button}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  for (const key of [...state.keys].reverse()) {
    try {
      await pressKeyUp(page, key);
      released.keys.push(key);
    } catch (error) {
      errors.push(`key ${key}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return { released, errors };
}

function ok(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function fail(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function cleanText(value, limit = MAX_TEXT_BYTES) {
  const text = String(value ?? "").replace(/\u0000/g, "");
  return text.length > limit ? `${text.slice(0, limit)}\n[… içerik kesildi …]` : text;
}

export function validateHttpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Yalnızca http:// veya https:// adreslerine izin verilir.");
  }
  return url.toString();
}

export function parseCookieHeader(header, url) {
  const target = validateHttpUrl(url);
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) throw new Error("Cookie başlığı name=value biçiminde olmalı.");
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        url: target,
        path: "/",
      };
    });
}

function cookieDescription(cookie) {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
}

function activeHttpUrl() {
  if (!activePage || activePage.isClosed()) return undefined;
  const value = activePage.url();
  return value.startsWith("http://") || value.startsWith("https://") ? value : undefined;
}

async function ensureBrowser(headless = false) {
  if (context) return context;
  if (browserStartPromise) return browserStartPromise;

  browserStartPromise = (async () => {
    await mkdir(PROFILE_DIR, { recursive: true });
    const nextContext = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    nextContext.setDefaultTimeout(15_000);
    nextContext.setDefaultNavigationTimeout(30_000);
    context = nextContext;
    activePage = nextContext.pages()[0] || (await nextContext.newPage());
    for (const page of nextContext.pages()) watchPage(page);
    nextContext.on("page", (page) => {
      watchPage(page);
      activePage = page;
    });
    nextContext.on("close", () => {
      context = null;
      activePage = null;
    });
    return nextContext;
  })();

  try {
    return await browserStartPromise;
  } finally {
    browserStartPromise = null;
  }
}

async function requirePage(headless = false) {
  const browserContext = await ensureBrowser(headless);
  if (!activePage || activePage.isClosed()) {
    activePage = browserContext.pages()[0] || (await browserContext.newPage());
    watchPage(activePage);
  }
  return activePage;
}

async function pageSummary(page = activePage) {
  if (!page || page.isClosed()) return { active: false };
  let title = "";
  try {
    title = await page.title();
  } catch {
    // The page can close while a client is reading its status.
  }
  return { active: true, url: page.url(), title };
}

function getTarget(page, input, prefix = "") {
  const value = (name) => input[prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name];
  if (value("role")) return page.getByRole(value("role"), { name: value("name"), exact: value("exact") }).first();
  if (value("label")) return page.getByLabel(value("label"), { exact: value("exact") }).first();
  if (value("placeholder")) return page.getByPlaceholder(value("placeholder"), { exact: value("exact") }).first();
  if (value("testId")) return page.getByTestId(value("testId")).first();
  if (value("selector")) return page.locator(value("selector")).first();
  if (value("text")) return page.getByText(value("text"), { exact: value("exact") }).first();
  return null;
}

function locatorTargetCount(input, prefix = "") {
  const value = (name) => input[prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name];
  return ["selector", "text", "role", "label", "placeholder", "testId"].filter((key) => value(key) !== undefined).length;
}

function assertClickTarget(input) {
  const locatorCount = locatorTargetCount(input);
  const pointLike = input.x !== undefined || input.y !== undefined;
  if (input.name !== undefined && input.role === undefined) {
    throw new Error("name yalnızca role ile birlikte kullanılabilir.");
  }
  if (locatorCount > 1 || (locatorCount === 0) === !pointLike) {
    throw new Error("Tam olarak tek bir locator veya x+y koordinatı verin.");
  }
  if (pointLike && (input.x === undefined || input.y === undefined)) {
    throw new Error("Koordinat tıklaması için x ve y birlikte verilmelidir.");
  }
}

async function showPointer(page, x, y, { persistent = false } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  await page.evaluate(({ x: left, y: top, persistent: keepVisible }) => {
    const previous = document.getElementById("__local_browser_mcp_pointer");
    previous?.remove();
    const dot = document.createElement("div");
    dot.id = "__local_browser_mcp_pointer";
    Object.assign(dot.style, {
      position: "fixed",
      left: `${left - 9}px`,
      top: `${top - 9}px`,
      width: "18px",
      height: "18px",
      border: "3px solid #ff1744",
      borderRadius: "50%",
      background: "rgba(255, 23, 68, .2)",
      boxSizing: "border-box",
      zIndex: "2147483647",
      pointerEvents: "none",
      transition: "transform .15s ease, opacity .35s ease",
    });
    document.documentElement.appendChild(dot);
    if (!keepVisible) {
      setTimeout(() => {
        dot.style.transform = "scale(1.7)";
        dot.style.opacity = "0";
      }, 120);
      setTimeout(() => dot.remove(), 700);
    }
  }, { x, y, persistent }).catch(() => {});
}

async function setPointerPressed(page, pressed) {
  await page.evaluate((isPressed) => {
    const pointer = document.getElementById("__local_browser_mcp_pointer");
    if (!pointer) return;
    pointer.dataset.pressed = String(isPressed);
    pointer.style.background = isPressed ? "rgba(255, 23, 68, .55)" : "rgba(255, 23, 68, .2)";
    pointer.style.boxShadow = isPressed ? "0 0 0 5px rgba(255, 23, 68, .25)" : "none";
    pointer.style.transform = isPressed ? "scale(.82)" : "scale(1)";
  }, pressed).catch(() => {});
}

async function targetPoint(page, input, prefix = "target") {
  const locatorCount = locatorTargetCount(input, prefix);
  const x = input[`${prefix}X`];
  const y = input[`${prefix}Y`];
  const hasLocator = locatorCount > 0;
  const hasPoint = x !== undefined || y !== undefined;
  if (locatorCount > 1 || hasLocator === hasPoint || (hasPoint && (x === undefined || y === undefined))) {
    throw new Error(`${prefix} için tek locator veya x+y koordinatı verin.`);
  }
  if (hasPoint) return { x, y };
  if (input[`${prefix}Name`] !== undefined && input[`${prefix}Role`] === undefined) {
    throw new Error(`${prefix}Name yalnızca ${prefix}Role ile birlikte kullanılabilir.`);
  }
  const target = getTarget(page, input, prefix);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${prefix} gorunur bir hedef degil.`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function visibleElementData(frame) {
  return frame.evaluate(() => {
    const selector = "a[href],button,input,textarea,select,summary,[role='button'],[role='link'],[onclick],[tabindex]:not([tabindex='-1']),canvas";
    const cssPath = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        let part = current.tagName.toLowerCase();
        let index = 1;
        let sibling = current;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName === current.tagName) index += 1;
        }
        part += `:nth-of-type(${index})`;
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return Boolean(
        box.width > 2 &&
          box.height > 2 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          style.pointerEvents !== "none" &&
          !element.hasAttribute("hidden") &&
          !element.matches(":disabled,[aria-disabled='true']"),
      );
    };
    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        const top = document.elementFromPoint(centerX, centerY);
        const covered = top && top !== element && !element.contains(top);
        const text = (element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title") ||
          element.innerText ||
          element.getAttribute("alt") ||
          element.getAttribute("value") ||
          "").replace(/\s+/g, " ").trim().slice(0, 160);
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || undefined,
          text,
          selector: cssPath(element),
          x: Math.round(centerX),
          y: Math.round(centerY),
          width: Math.round(box.width),
          height: Math.round(box.height),
          covered,
        };
      })
      .filter((item) => !item.covered)
      .slice(0, 150);
  });
}

async function clickableElements(page) {
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const elements = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    if (!frame || frame.isDetached()) continue;
    let items;
    try {
      items = await visibleElementData(frame);
    } catch {
      continue;
    }
    let offsetX = 0;
    let offsetY = 0;
    if (frame !== page.mainFrame()) {
      try {
        const box = await frame.frameElement().then((element) => element.boundingBox());
        if (!box) continue;
        offsetX = box.x;
        offsetY = box.y;
      } catch {
        continue;
      }
    }
    for (const item of items) {
      elements.push({
        ...item,
        x: Math.round(item.x + offsetX),
        y: Math.round(item.y + offsetY),
        frameIndex,
        frameUrl: frame.url(),
      });
    }
  }
  return { viewport, elements };
}

async function executeActionOnce(page, action) {
  switch (action.type) {
    case "click": {
      assertClickTarget(action);
      const target = getTarget(page, action);
      if (target) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        if (!box) throw new Error("Tiklama hedefi gorunur degil.");
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y, { steps: action.steps });
        await showPointer(page, x, y, { persistent: true });
        await target.click({ button: action.button, clickCount: action.clickCount });
      } else {
        await page.mouse.move(action.x, action.y, { steps: action.steps });
        await showPointer(page, action.x, action.y, { persistent: true });
        await page.mouse.click(action.x, action.y, { button: action.button, clickCount: action.clickCount });
      }
      break;
    }
    case "move":
      if (action.x === undefined || action.y === undefined) throw new Error("move icin x+y gerekir.");
      await page.mouse.move(action.x, action.y, { steps: action.steps });
      await showPointer(page, action.x, action.y, { persistent: true });
      break;
    case "down":
      await pressMouseDown(page, action.button, 1);
      await setPointerPressed(page, true);
      break;
    case "up":
      await pressMouseUp(page, action.button);
      await setPointerPressed(page, false);
      break;
    case "key_down":
      await pressKeyDown(page, action.key);
      break;
    case "key_up":
      await pressKeyUp(page, action.key);
      break;
    case "press":
      await page.keyboard.press(action.key, { delay: action.delayMs });
      break;
    case "type":
      await page.keyboard.type(action.text, { delay: action.delayMs });
      break;
    case "wheel":
      await page.mouse.wheel(action.deltaX, action.deltaY);
      break;
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, action.ms));
      break;
    default:
      throw new Error(`Bilinmeyen action: ${action.type}`);
  }
}

async function executeAction(page, action) {
  const repeat = action.repeat ?? 1;
  if (repeat > 1 && !["click", "press", "type", "wheel"].includes(action.type)) {
    throw new Error(`repeat is not supported for ${action.type}; use click, press, type, or wheel.`);
  }
  await runRepeatedAction(repeat, action.intervalMs ?? 0, () => executeActionOnce(page, action));
  if (action.afterMs) await new Promise((resolve) => setTimeout(resolve, action.afterMs));
}

const enqueueBrowserOperation = createSerialQueue();
const serializedBrowserTools = new Set([
  "browser_start",
  "browser_mouse_move",
  "browser_mouse_button",
  "browser_keyboard",
  "browser_drag",
  "browser_actions",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_release_inputs",
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_keypress",
  "browser_mcp_pointer",
  "browser_import_cookies",
  "browser_save_profile",
  "browser_close",
]);

function registerBrowserTool(server, name, options, handler) {
  server.registerTool(name, options, (...args) => {
    const operation = () => handler(...args);
    return serializedBrowserTools.has(name) ? enqueueBrowserOperation(operation) : operation();
  });
}

function registerTools(server) {
  const actionSchema = z.object({
    type: z.enum(["click", "move", "down", "up", "key_down", "key_up", "press", "type", "wheel", "wait"]),
    selector: z.string().min(1).max(2_000).optional(),
    text: z.string().max(100_000).optional(),
    role: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(500).optional(),
    label: z.string().min(1).max(500).optional(),
    placeholder: z.string().min(1).max(500).optional(),
    testId: z.string().min(1).max(500).optional(),
    exact: z.boolean().optional().default(true),
    x: z.number().min(0).max(20_000).optional(),
    y: z.number().min(0).max(20_000).optional(),
    button: z.enum(["left", "right", "middle"]).optional().default("left"),
    clickCount: z.number().int().min(1).max(3).optional().default(1),
    steps: z.number().int().min(1).max(200).optional().default(8),
    key: z.string().min(1).max(100).optional(),
    deltaX: z.number().min(-100_000).max(100_000).optional().default(0),
    deltaY: z.number().min(-100_000).max(100_000).optional().default(0),
    ms: z.number().int().min(0).max(30_000).optional().default(0),
    delayMs: z.number().int().min(0).max(500).optional().default(0),
    repeat: z.number().int().min(1).max(100).optional().default(1),
    intervalMs: z.number().int().min(0).max(2_000).optional().default(40),
    afterMs: z.number().int().min(0).max(2_000).optional().default(20),
  });

  registerBrowserTool(server,
    "browser_start",
    {
      title: "Tarayıcıyı başlat",
      description:
        "Kalıcı yerel profille tarayıcıyı başlatır. Profil hesapları ve oturumları korur; ilk çağrıda tarayıcı süreci açılır.",
      inputSchema: {
        url: z.string().max(2048).optional(),
        headless: z.boolean().optional().default(false),
      },
    },
    async ({ url, headless }) => {
      try {
        const page = await requirePage(headless);
        if (url) await page.goto(validateHttpUrl(url), { waitUntil: "domcontentloaded" });
        return ok(JSON.stringify({ ...await pageSummary(page), profileDir: PROFILE_DIR }, null, 2));
      } catch (error) {
        return fail(`Tarayıcı başlatılamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_clickable_elements",
    {
      title: "Clickable elements and coordinates",
      description:
        "Returns visible buttons, links, inputs, canvas elements and their viewport coordinates. Use these coordinates before coordinate clicks to reduce misclicks.",
      inputSchema: {},
    },
    async () => {
      try {
        const page = await requirePage();
        return ok(JSON.stringify({ ...(await pageSummary(page)), ...(await clickableElements(page)) }, null, 2));
      } catch (error) {
        return fail(`Clickable element scan failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_observe",
    {
      title: "Observe browser",
      description: "Returns a current screenshot together with visible clickable element coordinates and page status.",
      inputSchema: { fullPage: z.boolean().optional().default(false) },
    },
    async ({ fullPage }) => {
      try {
        const page = await requirePage();
        const image = await page.screenshot({ type: "png", fullPage });
        if (image.byteLength > MAX_SCREENSHOT_BYTES) return fail("Screenshot exceeds 8 MB; use fullPage=false.");
        return {
          content: [
            { type: "image", data: image.toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify({ ...(await pageSummary(page)), ...(await clickableElements(page)) }, null, 2) },
          ],
        };
      } catch (error) {
        return fail(`Browser observation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_mouse_move",
    {
      title: "Move browser mouse",
      description: "Moves the real Playwright mouse to viewport coordinates and leaves a visible virtual pointer in the page.",
      inputSchema: {
        x: z.number().min(0).max(20_000),
        y: z.number().min(0).max(20_000),
        steps: z.number().int().min(1).max(300).optional().default(12),
      },
    },
    async ({ x, y, steps }) => {
      try {
        const page = await requirePage();
        await page.mouse.move(x, y, { steps });
        await showPointer(page, x, y, { persistent: true });
        return ok(JSON.stringify({ action: "move", x, y, steps, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        return fail(`Mouse move failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_mouse_button",
    {
      title: "Browser mouse button",
      description: "Presses or releases a real mouse button; click uses viewport coordinates. Coordinates on down/up can be used to keep a button held across calls for games and drag interactions.",
      inputSchema: {
        action: z.enum(["down", "up", "click"]),
        button: z.enum(["left", "right", "middle"]).optional().default("left"),
        x: z.number().min(0).max(20_000).optional(),
        y: z.number().min(0).max(20_000).optional(),
        clickCount: z.number().int().min(1).max(3).optional().default(1),
        steps: z.number().int().min(1).max(300).optional().default(8),
      },
    },
    async ({ action, button, x, y, clickCount, steps }) => {
      try {
        if ((x === undefined) !== (y === undefined)) throw new Error("x ve y birlikte verilmelidir.");
        if (action === "click" && (x === undefined || y === undefined)) throw new Error("click için x ve y gereklidir.");
        const page = await requirePage();
        if (x !== undefined && y !== undefined) {
          await page.mouse.move(x, y, { steps });
          await showPointer(page, x, y, { persistent: true });
        }
        if (action === "down") await pressMouseDown(page, button, clickCount);
        if (action === "up") await pressMouseUp(page, button);
        if (action === "click") await page.mouse.click(x, y, { button, clickCount });
        if (action === "down" || action === "up") await setPointerPressed(page, action === "down");
        return ok(JSON.stringify({ action, button, x, y, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        return fail(`Mouse button action failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_keyboard",
    {
      title: "Browser keyboard",
      description: "Sends real keyboard press, key-down, key-up or text typing events to the active browser page.",
      inputSchema: {
        action: z.enum(["press", "down", "up", "type"]),
        key: z.string().min(1).max(100).optional(),
        text: z.string().max(100_000).optional(),
        delayMs: z.number().int().min(0).max(500).optional().default(0),
      },
    },
    async ({ action, key, text, delayMs }) => {
      try {
        const page = await requirePage();
        if (action === "type") {
          if (text === undefined) throw new Error("type için text gereklidir.");
          await page.keyboard.type(text, { delay: delayMs });
        } else {
          if (!key) throw new Error(`${action} için key gereklidir.`);
          if (action === "press") await page.keyboard.press(key, { delay: delayMs });
          if (action === "down") await pressKeyDown(page, key);
          if (action === "up") await pressKeyUp(page, key);
        }
        return ok(JSON.stringify({ action, key, textLength: text?.length ?? 0, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        return fail(`Keyboard action failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_drag",
    {
      title: "Drag and drop",
      description: "Performs a real mouse drag between selectors/text targets or viewport coordinates, with visible pointer movement.",
      inputSchema: {
        sourceSelector: z.string().min(1).max(2_000).optional(),
        sourceText: z.string().min(1).max(500).optional(),
        sourceRole: z.string().min(1).max(100).optional(),
        sourceName: z.string().min(1).max(500).optional(),
        sourceLabel: z.string().min(1).max(500).optional(),
        sourcePlaceholder: z.string().min(1).max(500).optional(),
        sourceTestId: z.string().min(1).max(500).optional(),
        sourceX: z.number().min(0).max(20_000).optional(),
        sourceY: z.number().min(0).max(20_000).optional(),
        targetSelector: z.string().min(1).max(2_000).optional(),
        targetText: z.string().min(1).max(500).optional(),
        targetRole: z.string().min(1).max(100).optional(),
        targetName: z.string().min(1).max(500).optional(),
        targetLabel: z.string().min(1).max(500).optional(),
        targetPlaceholder: z.string().min(1).max(500).optional(),
        targetTestId: z.string().min(1).max(500).optional(),
        targetX: z.number().min(0).max(20_000).optional(),
        targetY: z.number().min(0).max(20_000).optional(),
        exact: z.boolean().optional().default(true),
        button: z.enum(["left", "right", "middle"]).optional().default("left"),
        steps: z.number().int().min(1).max(300).optional().default(24),
        holdMs: z.number().int().min(0).max(2_000).optional().default(80),
      },
    },
    async (input) => {
      try {
        const page = await requirePage();
        const source = await targetPoint(page, input, "source");
        const target = await targetPoint(page, input, "target");
        await page.mouse.move(source.x, source.y, { steps: input.steps });
        await showPointer(page, source.x, source.y);
        await pressMouseDown(page, input.button, 1);
        await setPointerPressed(page, true);
        try {
          if (input.holdMs) await new Promise((resolve) => setTimeout(resolve, input.holdMs));
          await page.mouse.move(target.x, target.y, { steps: input.steps });
          await showPointer(page, target.x, target.y, { persistent: true });
          await setPointerPressed(page, true);
        } finally {
          await pressMouseUp(page, input.button);
          await setPointerPressed(page, false);
        }
        return ok(JSON.stringify({ source, target, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        return fail(`Drag failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_actions",
    {
      title: "Run browser action sequence",
      description:
        "Runs an exclusive sequence of up to 200 mouse, key press/down/up, typing, wheel and wait actions. Use repeat (up to 100) and intervalMs for repeated clicks/keys/text; use afterMs between different steps when a game/page needs time to respond.",
      inputSchema: { actions: z.array(actionSchema).min(1).max(200) },
    },
    async ({ actions }) => {
      let page;
      let executed = 0;
      let executedActions = 0;
      try {
        page = await requirePage();
        for (const [index, action] of actions.entries()) {
          if (["key_down", "key_up", "press"].includes(action.type) && !action.key) {
            throw new Error(`Action ${index + 1}: key is required.`);
          }
          if (action.type === "type" && action.text === undefined) {
            throw new Error(`Action ${index + 1}: text is required.`);
          }
          try {
            await executeAction(page, action);
          } catch (error) {
            if (error instanceof Error) error.actionIndex = index + 1;
            executedActions += Math.max(0, (error?.repeatIndex ?? 1) - 1);
            throw error;
          }
          executed = index + 1;
          executedActions += action.repeat ?? 1;
        }
        return ok(JSON.stringify({ executed: actions.length, executedActions, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        const inputState = page ? pageHeldInputs(page) : { keys: new Set(), buttons: new Set() };
        let releasedInputs = { keys: [], buttons: [], errors: [] };
        if (page && !page.isClosed()) {
          releasedInputs = await releaseInputs(page);
          try {
            await setPointerPressed(page, false);
          } catch {
            // The page may have navigated or closed while recovering from the failed action.
          }
        }
        return fail(JSON.stringify({
          error: error instanceof Error ? error.message : "unknown error",
          executed,
          executedActions,
          failedAction: error?.actionIndex ?? executed + 1,
          failedRepeat: error?.repeatIndex,
          releasedKeys: releasedInputs.keys,
          releasedButtons: releasedInputs.buttons,
          releaseErrors: releasedInputs.errors,
          heldKeys: [...inputState.keys].filter((key) => !releasedInputs.keys.includes(key)),
          heldButtons: [...inputState.buttons].filter((button) => !releasedInputs.buttons.includes(button)),
          ...(page ? await pageSummary(page) : {}),
        }, null, 2));
      }
    },
  );

  registerBrowserTool(server,
    "browser_status",
    {
      title: "Tarayıcı durumunu al",
      description: "Tarayıcı açık mı, etkin sayfa hangi adreste ve başlıkta gösterir.",
    },
    async () => ok(JSON.stringify(await pageSummary(), null, 2)),
  );

  registerBrowserTool(server,
    "browser_tabs",
    {
      title: "List browser tabs",
      description: "Lists open tabs with their index, title, URL and active state. Use the index with browser_switch_tab or browser_close_tab.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!context) return ok(JSON.stringify({ active: false, tabs: [] }, null, 2));
        const tabs = await Promise.all(context.pages().map(async (page, index) => ({
          index,
          ...(await pageSummary(page)),
          active: page === activePage,
        })));
        return ok(JSON.stringify({ active: true, tabs }, null, 2));
      } catch (error) {
        return fail(`Tab list failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_new_tab",
    {
      title: "Open browser tab",
      description: "Opens a new visible tab and makes it the active tab. An optional URL must use http or https.",
      inputSchema: { url: z.string().max(2048).optional() },
    },
    async ({ url }) => {
      try {
        const targetUrl = url ? validateHttpUrl(url) : undefined;
        const browserContext = await ensureBrowser();
        const page = await browserContext.newPage();
        activePage = page;
        if (targetUrl) await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        return ok(JSON.stringify(await pageSummary(page), null, 2));
      } catch (error) {
        return fail(`New tab failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_switch_tab",
    {
      title: "Switch browser tab",
      description: "Activates an open tab by its zero-based index from browser_tabs.",
      inputSchema: { index: z.number().int().min(0).max(100) },
    },
    async ({ index }) => {
      try {
        const browserContext = await ensureBrowser();
        const page = browserContext.pages()[index];
        if (!page || page.isClosed()) throw new Error(`Tab index ${index} does not exist.`);
        activePage = page;
        await page.bringToFront();
        return ok(JSON.stringify({ index, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        return fail(`Tab switch failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_close_tab",
    {
      title: "Close browser tab",
      description: "Closes one open tab by its zero-based index; other tabs and the persistent profile remain open.",
      inputSchema: { index: z.number().int().min(0).max(100) },
    },
    async ({ index }) => {
      try {
        const browserContext = await ensureBrowser();
        const page = browserContext.pages()[index];
        if (!page || page.isClosed()) throw new Error(`Tab index ${index} does not exist.`);
        await page.close();
        const pages = browserContext.pages();
        activePage = pages.at(-1) || null;
        if (activePage) await activePage.bringToFront();
        return ok(JSON.stringify({ closedIndex: index, tabsRemaining: pages.length, ...(await pageSummary(activePage)) }, null, 2));
      } catch (error) {
        return fail(`Tab close failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_release_inputs",
    {
      title: "Release held browser inputs",
      description: "Releases mouse buttons and keyboard keys previously held through this MCP. Use after an interrupted game or drag action to prevent stuck controls.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!context || !activePage || activePage.isClosed()) return ok(JSON.stringify({ released: { keys: [], buttons: [] }, errors: [] }));
        const results = await Promise.all(context.pages().map(async (page) => ({
          url: page.url(),
          ...(await releaseInputs(page)),
        })));
        await setPointerPressed(activePage, false);
        return ok(JSON.stringify({ tabs: results, ...(await pageSummary(activePage)) }, null, 2));
      } catch (error) {
        return fail(`Input release failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_open",
    {
      title: "Siteyi aç",
      description: "Etkin sekmede yalnızca http/https adresini açar.",
      inputSchema: { url: z.string().min(1).max(2048) },
    },
    async ({ url }) => {
      try {
        const page = await requirePage();
        await page.goto(validateHttpUrl(url), { waitUntil: "domcontentloaded" });
        return ok(JSON.stringify(await pageSummary(page), null, 2));
      } catch (error) {
        return fail(`Site açılamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_page_content",
    {
      title: "Sayfa metnini al",
      description: "Etkin sayfanın başlık, adres ve görünür metnini modele verir; metin uzunluğu sınırlıdır.",
    },
    async () => {
      try {
        const page = await requirePage();
        const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
        return ok(JSON.stringify({ ...(await pageSummary(page)), text: cleanText(text) }, null, 2));
      } catch (error) {
        return fail(`Sayfa metni alınamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_screenshot",
    {
      title: "Ekran görüntüsü al",
      description: "Etkin sekmenin PNG ekran görüntüsünü MCP image içeriği olarak döndürür.",
      inputSchema: { fullPage: z.boolean().optional().default(false) },
    },
    async ({ fullPage }) => {
      try {
        const page = await requirePage();
        const image = await page.screenshot({ type: "png", fullPage });
        if (image.byteLength > MAX_SCREENSHOT_BYTES) {
          return fail("Ekran görüntüsü 8 MB sınırını aşıyor; fullPage=false ile tekrar deneyin.");
        }
        return {
          content: [
            { type: "image", data: image.toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify(await pageSummary(page)) },
          ],
        };
      } catch (error) {
        return fail(`Ekran görüntüsü alınamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_click",
    {
      title: "Tıkla",
      description: "Clicks an element by accessible role/name, label, placeholder, test ID, CSS selector or visible text; coordinates are available for canvas and games.",
      inputSchema: {
        selector: z.string().min(1).max(2_000).optional(),
        text: z.string().min(1).max(500).optional(),
        role: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(500).optional(),
        label: z.string().min(1).max(500).optional(),
        placeholder: z.string().min(1).max(500).optional(),
        testId: z.string().min(1).max(500).optional(),
        exact: z.boolean().optional().default(true),
        x: z.number().int().min(0).max(20_000).optional(),
        y: z.number().int().min(0).max(20_000).optional(),
        button: z.enum(["left", "right", "middle"]).optional().default("left"),
        clickCount: z.number().int().min(1).max(3).optional().default(1),
      },
    },
    async (input) => {
      try {
        assertClickTarget(input);
        const page = await requirePage();
        const target = getTarget(page, input);
        if (target) {
          await target.scrollIntoViewIfNeeded();
          const box = await target.boundingBox();
          if (box) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y, { steps: 8 });
            await showPointer(page, x, y);
          }
          await target.click({ button: input.button, clickCount: input.clickCount });
        } else {
          await page.mouse.move(input.x, input.y, { steps: 8 });
          await showPointer(page, input.x, input.y);
          await page.mouse.click(input.x, input.y, { button: input.button, clickCount: input.clickCount });
        }
        return ok(JSON.stringify(await pageSummary(page), null, 2));
      } catch (error) {
        return fail(`Tıklama yapılamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_type",
    {
      title: "Metin yaz",
      description: "Fills a form field by accessible label, placeholder, role/name, test ID or CSS selector.",
      inputSchema: {
        selector: z.string().min(1).max(2_000).optional(),
        label: z.string().min(1).max(500).optional(),
        placeholder: z.string().min(1).max(500).optional(),
        role: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(500).optional(),
        testId: z.string().min(1).max(500).optional(),
        exact: z.boolean().optional().default(true),
        text: z.string().max(100_000),
        clear: z.boolean().optional().default(true),
      },
    },
    async ({ selector, label, placeholder, role, name, testId, exact, text, clear }) => {
      try {
        const targetInput = { selector, label, placeholder, role, name, testId, exact };
        if (locatorTargetCount(targetInput) !== 1 || (name !== undefined && role === undefined)) {
          throw new Error("Bir hedef seçin: label, placeholder, role+name, testId veya selector.");
        }
        const page = await requirePage();
        const target = getTarget(page, targetInput);
        if (clear) await target.fill(text);
        else await target.pressSequentially(text);
        return ok("Metin yazıldı.");
      } catch (error) {
        return fail(`Metin yazılamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_keypress",
    {
      title: "Tuşa bas",
      description: "Etkin sayfada veya seçilen elementte Playwright klavye tuşuna basar.",
      inputSchema: {
        key: z.string().min(1).max(100),
        selector: z.string().min(1).max(2_000).optional(),
      },
    },
    async ({ key, selector }) => {
      try {
        const page = await requirePage();
        if (selector) await page.locator(selector).first().press(key);
        else await page.keyboard.press(key);
        return ok("Tuş gönderildi.");
      } catch (error) {
        return fail(`Tuş gönderilemedi: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_wait",
    {
      title: "Wait for browser state",
      description: "Waits for a selector or text to reach a state, for the URL to contain a value, or for a short delay. Use after clicks/navigation to confirm the result before continuing.",
      inputSchema: {
        selector: z.string().min(1).max(2_000).optional(),
        text: z.string().min(1).max(2_000).optional(),
        exact: z.boolean().optional().default(true),
        state: z.enum(["visible", "hidden", "attached", "detached"]).optional().default("visible"),
        urlContains: z.string().min(1).max(2048).optional(),
        timeoutMs: z.number().int().min(1).max(30_000).optional().default(10_000),
        ms: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async ({ selector, text, exact, state, urlContains, timeoutMs, ms }) => {
      try {
        const targetCount = Number(Boolean(selector)) + Number(Boolean(text)) + Number(Boolean(urlContains));
        if (targetCount > 1) throw new Error("selector, text veya urlContains seçeneklerinden yalnızca birini kullanın.");
        if (targetCount === 0 && ms === undefined) throw new Error("Beklemek için selector, text, urlContains veya ms gereklidir.");
        const page = await requirePage();
        if (selector) await page.locator(selector).first().waitFor({ state, timeout: timeoutMs });
        if (text) await page.getByText(text, { exact }).first().waitFor({ state, timeout: timeoutMs });
        if (urlContains) {
          await page.waitForURL((url) => url.href.includes(urlContains), { timeout: timeoutMs });
        }
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
        return ok(JSON.stringify({ waitedFor: selector ? { selector, state } : text ? { text, state } : urlContains ? { urlContains } : { ms }, ...(await pageSummary(page)) }, null, 2));
      } catch (error) {
        return fail(`Bekleme başarısız: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  const cookieSchema = z.object({
    name: z.string().min(1).max(256),
    value: z.string().max(16_384),
    url: z.string().max(2048).optional(),
    domain: z.string().max(512).optional(),
    path: z.string().max(512).optional().default("/"),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  });

  registerBrowserTool(server,
    "browser_import_cookies",
    {
      title: "Cookie içe aktar",
      description:
        "Cookie nesnelerini veya bir Cookie: name=value başlığını kalıcı profile ekler. Cookie değerleri hiçbir zaman sonuçta, logda veya status aracında gösterilmez.",
      inputSchema: {
        cookies: z.array(cookieSchema).max(100).optional(),
        cookieHeader: z.string().max(100_000).optional(),
        url: z.string().max(2048).optional(),
      },
    },
    async ({ cookies, cookieHeader, url }) => {
      try {
        if (!cookies && !cookieHeader) throw new Error("cookies veya cookieHeader verin.");
        if (cookies && cookieHeader) throw new Error("cookies ve cookieHeader birlikte verilemez.");
        const targetUrl = url || activeHttpUrl();
        if (cookieHeader && !targetUrl) {
          throw new Error("Cookie başlığı için http/https url veya açık bir tarayıcı sayfası gerekir.");
        }
        const imported = cookieHeader
          ? parseCookieHeader(cookieHeader, targetUrl)
          : cookies.map((cookie) => {
              const normalized = { ...cookie };
              if (normalized.url) normalized.url = validateHttpUrl(normalized.url);
              else if (!normalized.domain && targetUrl) normalized.url = validateHttpUrl(targetUrl);
              if (!normalized.url && !normalized.domain) {
                throw new Error("Her cookie için url/domain veya ortak url verilmelidir.");
              }
              return normalized;
            });
        const browserContext = await ensureBrowser();
        await browserContext.addCookies(imported);
        return ok(`${imported.length} cookie profile eklendi. Değerler gizli tutuldu.`);
      } catch (error) {
        return fail(`Cookie içe aktarılamadı: ${error instanceof Error ? error.message : "format hatası"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_cookie_names",
    {
      title: "Cookie listesini al",
      description: "Cookie değerlerini vermeden ad, alan adı ve güvenlik özelliklerini listeler.",
    },
    async () => {
      try {
        const browserContext = await ensureBrowser();
        const cookies = await browserContext.cookies();
        return ok(JSON.stringify(cookies.map(cookieDescription), null, 2));
      } catch (error) {
        return fail(`Cookie listesi alınamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
      }
    },
  );

  registerBrowserTool(server,
    "browser_save_profile",
    {
      title: "Profili kaydet",
      description: "Kalıcı Playwright profile yapılan değişikliklerin diske yazılmasını bekler; cookie JSON'u dışa aktarmıyor.",
    },
    async () => {
      if (!context) return ok(`Tarayıcı kapalı; kalıcı profil yolu: ${PROFILE_DIR}`);
      await context.storageState();
      return ok(`Profil kaydedildi: ${PROFILE_DIR}`);
    },
  );

  registerBrowserTool(server,
    "browser_close",
    {
      title: "Tarayıcıyı kapat",
      description: "Tarayıcıyı kapatır; kalıcı profil ve hesap oturumları yerinde kalır.",
    },
    async () => {
      if (!context) return ok("Tarayıcı zaten kapalı.");
      const closing = context;
      await closing.close();
      return ok("Tarayıcı kapatıldı; profil korunuyor.");
    },
  );
}

function createMcpServer() {
  const server = new McpServer(
    {
      name: APP_NAME,
      version: "0.1.0",
    },
    {
      instructions:
        "Bu sunucu yalnızca kullanıcının yerel, kalıcı tarayıcı profiline erişir. Hassas cookie değerlerini istemeyin veya cevaba yazmayın. Önce browser_status/browser_start, sonra page_content veya screenshot kullanın; tıklama ve form gönderme gibi yan etkili işlemleri kullanıcı amacıyla sınırlayın.",
    },
  );
  registerTools(server);
  return server;
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) throw new Error("İstek gövdesi çok büyük.");
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function textHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function allowedHost(host) {
  if (!host) return false;
  const normalized = host.toLowerCase().split(":")[0].replace(/\[|\]/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function tokenFromDisk() {
  const configured = process.env.BROWSER_MCP_TOKEN?.trim();
  if (configured) return configured;
  mkdirSync(APP_DATA_DIR, { recursive: true });
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(TOKEN_PATH, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

function authorized(request, token) {
  const authorization = textHeader(request.headers.authorization);
  if (authorization === `Bearer ${token}`) return true;
  return textHeader(request.headers["x-browser-mcp-token"]) === token;
}

function sendJson(response, statusCode, value, headers = {}) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(body);
}

function badRequest(response, message) {
  sendJson(response, 400, { error: message });
}

async function startHttp() {
  if (!Number.isInteger(HTTP_PORT) || HTTP_PORT < 1024 || HTTP_PORT > 65_535) {
    throw new Error("BROWSER_MCP_PORT 1024-65535 aralığında olmalı.");
  }
  const token = tokenFromDisk();
  const transports = new Map();

  const httpServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${HTTP_HOST}:${HTTP_PORT}`);
    if (requestUrl.pathname !== "/mcp" && requestUrl.pathname !== "/health") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (!allowedHost(request.headers.host)) {
      sendJson(response, 403, { error: "Local host required" });
      return;
    }
    if (!authorized(request, token)) {
      sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (requestUrl.pathname === "/health") {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      sendJson(response, 200, {
        ok: true,
        pid: process.pid,
        browserActive: Boolean(context),
        page: await pageSummary(),
        profileDir: PROFILE_DIR,
      });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, { allow: "GET, POST, DELETE, OPTIONS" });
      response.end();
      return;
    }

    try {
      const sessionId = textHeader(request.headers["mcp-session-id"]);
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport && !sessionId && isInitializeRequest(body)) {
          let server;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, { transport, server });
            },
            onsessionclosed: async (closedSessionId) => {
              const session = transports.get(closedSessionId);
              transports.delete(closedSessionId);
              if (session?.server) await session.server.close();
            },
          });
          server = createMcpServer();
          await server.connect(transport);
          await transport.handleRequest(request, response, body);
          return;
        }
        if (!transport) {
          badRequest(response, "Geçerli MCP session id gerekli.");
          return;
        }
        await transport.transport.handleRequest(request, response, body);
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        const session = sessionId ? transports.get(sessionId) : undefined;
        if (!session) {
          badRequest(response, "Geçerli MCP session id gerekli.");
          return;
        }
        await session.transport.handleRequest(request, response);
        return;
      }
      response.writeHead(405, { allow: "GET, POST, DELETE, OPTIONS" });
      response.end();
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : "unknown error");
      sendJson(response, 500, { error: "Internal server error" });
    }
  });

  httpServer.keepAliveTimeout = 5_000;
  httpServer.requestTimeout = 60_000;
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(HTTP_PORT, HTTP_HOST, resolve);
  });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  writeFileSync(PID_PATH, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  process.once("exit", () => {
    try {
      if (readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) unlinkSync(PID_PATH);
    } catch {
      // The PID file is only a convenience for the local control command.
    }
  });
  console.error(`local-browser-mcp HTTP listening on http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
  console.error(`MCP token file: ${TOKEN_PATH}`);

  const shutdown = async () => {
    for (const session of transports.values()) await session.transport.close().catch(() => {});
    await closeBrowser();
    await new Promise((resolve) => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

async function closeBrowser() {
  if (!context) return;
  const closing = context;
  context = null;
  activePage = null;
  await closing.close().catch(() => {});
}

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await closeBrowser();
    await server.close().catch(() => {});
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const mode = process.argv.includes("--http") ? "http" : "stdio";
  (mode === "http" ? startHttp() : startStdio()).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
