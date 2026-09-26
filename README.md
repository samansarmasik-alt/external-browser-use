# External Browser Use

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets AI agents operate a real, visible Chromium browser. It is built for practical browser work: inspect pages, choose reliable targets, click, type, drag, use the keyboard, and verify what happened.

The browser uses a persistent local profile, so sign-ins and site state can survive restarts. The server listens on loopback only and protects its HTTP MCP endpoint with a locally generated token.

## Highlights

- Visible Chromium controlled through Playwright.
- Screenshot, page state, readable page content, and clickable-element coordinates.
- Semantic targeting by accessible role/name, label, placeholder, test ID, or CSS selector; coordinates are available when needed.
- Mouse move and buttons, keyboard press/down/up, typing, wheel scrolling, and real drag-and-drop.
- Ordered, serialized action sequences (up to 200 steps) with repeated clicks/key presses and partial-progress reporting.
- Tab creation, listing, switching, and closing; wait for selectors, text, or URL changes.
- Persistent profile and optional cookie import. Cookie values are not returned in tool results or status output.
- Up to 24 simultaneous HTTP MCP clients, each with its own active page, tab list, and serialized action queue; `browser_session_status` reports capacity.
- Windows terminal menu for server state, agent integrations, and optional startup-on-login.

## Attach to an already-open browser

The MCP can attach to a browser session that was started with its local debugging interface enabled. It discovers supported local browser processes and provides tab listing/switching, screenshots, clickable coordinates, navigation, mouse/keyboard input, and serialized action sequences under the `browser_external_*` tools. Chromium-based browsers use CDP; Firefox-family browsers use WebDriver BiDi where supported by that browser build.

This cannot be enabled retroactively: close and relaunch the browser with a non-zero `--remote-debugging-port` (for example, `--remote-debugging-port=9222` for Chromium or `--remote-debugging-port=9223` for Firefox), then call `browser_external_discover` and `browser_external_connect`. Browser support depends on its version/build exposing the expected local protocol endpoint. The server accepts only loopback endpoints; do not expose debugging ports to a network. A debugging endpoint grants broad access to the signed-in session, so only connect trusted agents to browsers/profiles you intend them to control.

`browser_external_disconnect` and MCP shutdown detach the automation connection without closing the real browser, tabs, or profile. The agent's pointer and keyboard events target the browser page; this does not take over the operating-system desktop or move its physical cursor.

## Requirements

- Windows for the included management menu, startup integration, and one-key agent setup.
- Node.js 20 or newer and npm.
- Codex, OpenCode, CommandCode, Gemini CLI, and/or Antigravity installed if you want the manager to configure those clients.

## Install and run

```powershell
git clone https://github.com/samansarmasik-alt/external-browser-use.git
cd external-browser-use
npm ci
npm run install-browser
.\browser-mcp.cmd
```

The interactive menu can start or stop the MCP server, show live status, open the visible browser, and detect supported agent clients. In the agent status screen, press `K` to install the MCP connection for detected clients that do not have it yet. Restart the relevant agent after changing its MCP configuration.

To manage it directly from PowerShell:

```powershell
.\browser-mcp.cmd start
.\browser-mcp.cmd status
.\browser-mcp.cmd browser
.\browser-mcp.cmd agents
.\browser-mcp.cmd install-agents
.\browser-mcp.cmd stop
```

Use `install` to enable launch at Windows sign-in and `uninstall` to disable only that automatic launch. Uninstalling startup does not delete the project, browser profile, or cookies.

## MCP connection

The manager registers the local server with supported agents using Streamable HTTP. Supported clients are Codex, OpenCode, CommandCode, Gemini CLI, and Antigravity. The default endpoint is `http://127.0.0.1:7331/mcp`; the port can be changed with `BROWSER_MCP_PORT`. The listener is bound to `127.0.0.1`, not exposed to the local network.

Gemini CLI is configured in `%USERPROFILE%\.gemini\settings.json`; Antigravity uses `%USERPROFILE%\.gemini\config\mcp_config.json`. The manager merges the `local-browser` server entry into each file and preserves unrelated JSON settings. These user-level MCP configs contain the local bearer token; do not share or sync them publicly. Restart the client after setup.

The server creates an access token in `%LOCALAPPDATA%\local-browser-mcp\token` on first start. The setup command configures agent clients to use the local connection. Keep this token private; do not commit it, paste it into prompts, or share it in logs. If configuring a client manually, use the token as a bearer credential and never put its value in a checked-in config file.

## Browser tools

The MCP server exposes these tools:

| Area | Tools | Purpose |
| --- | --- | --- |
| Start and inspect | `browser_start`, `browser_status`, `browser_session_status`, `browser_observe`, `browser_screenshot`, `browser_page_content`, `browser_clickable_elements` | Start the browser; inspect this agent's session, page state, screenshots, text, and actionable coordinates. |
| Navigate and wait | `browser_open`, `browser_wait` | Open an HTTP(S) URL and wait for a selector, text, URL fragment, or duration. |
| Find and interact | `browser_click`, `browser_type`, `browser_keypress`, `browser_keyboard`, `browser_mouse_move`, `browser_mouse_button`, `browser_drag`, `browser_actions`, `browser_release_inputs`, `browser_mcp_pointer` | Use semantic locators or coordinates; perform individual or ordered mouse/keyboard actions and release held inputs. |
| Tabs | `browser_tabs`, `browser_new_tab`, `browser_switch_tab`, `browser_close_tab` | List and manage this agent's tabs (up to four). Browser actions operate on this agent's active tab. |
| Profile and cookies | `browser_import_cookies`, `browser_cookie_names`, `browser_save_profile`, `browser_close` | Import cookies, inspect cookie names without values, save the profile, or close this agent's tabs. |

Prefer semantic locators (for example, a button's accessible role and name) when available: they are generally more robust than screen coordinates. Use `browser_observe` or `browser_clickable_elements` to inspect coordinates when a page has canvas/game controls or no useful accessible elements. Each agent's MCP operations are serialized within that agent, keeping action batches ordered; separate agents have independent pages and queues and can work concurrently. `browser_actions` can chain up to 200 steps; `press` sends a complete key press, while `key_down`/`key_up` support holds. `repeat` (up to 100) and `intervalMs` repeat clicks, presses, text, or scrolling; `afterMs` adds a short response window between steps (20 ms by default). For example:

```json
{
  "actions": [
    { "type": "click", "role": "button", "name": "Continue", "repeat": 3, "intervalMs": 80 },
    { "type": "press", "key": "ArrowRight", "repeat": 4, "intervalMs": 50 },
    { "type": "key_down", "key": "Space" },
    { "type": "wait", "ms": 300 },
    { "type": "key_up", "key": "Space" }
  ]
}
```

If a step fails, the result reports completed steps, the failed step/repetition, and any input cleanup errors. MCP-held keys/buttons are automatically released after a failed batch; `browser_release_inputs` is also available for explicit recovery.

## Profile and privacy

The persistent Chromium profile is stored at `%LOCALAPPDATA%\local-browser-mcp\profile` by default. It can contain authenticated sessions and other sensitive browsing data. Treat it like a password manager: do not publish, sync, or share it. `BROWSER_MCP_DATA_DIR` can point to a different data directory.

Cookie import accepts Playwright cookie objects or a `Cookie` header paired with an HTTP(S) URL. Cookie values are used to create the browser session but are intentionally excluded from tool results, status output, and logs. Only import cookies you are authorized to use.

The server runs locally, but an agent controlling the browser can still navigate, click, type, and submit forms as the signed-in user. Review consequential actions and avoid giving untrusted agents access to sensitive profiles.

## Development

Run the tests and syntax checks with:

```powershell
npm test
node --check src/server.mjs
node --check src/control.mjs
```

Start the MCP server directly over stdio with `npm start`, or over local HTTP with `npm run start:http`. The interactive client manager and startup integration are Windows-specific.

## Resource usage

The MCP service does not launch Chromium until an agent requests a browser. HTTP mode accepts up to 24 simultaneous MCP clients and shares one visible Chromium process; each client gets its own managed page and can open up to four managed tabs. Actions are serialized per client, so separate agents do not share an active-page pointer or block each other's action queue. Managed tabs close after 15 minutes without MCP activity (set `BROWSER_MCP_IDLE_TAB_MS=0` to disable, or choose another millisecond value); the persistent profile keeps saved sign-ins/cookies, but unsaved in-page state is lost when an idle tab closes.

All managed pages use the same persistent browser profile. This preserves sign-ins and cookies, but it is not an isolation boundary: agents can act within the same signed-in profile. CPU and RAM depend on Chromium and the sites/tabs that are open; no fixed percentage is guaranteed. `browser_session_status` and the authenticated `/health` endpoint report connected-client and open-tab counts.

## License

No license has been added yet. Unless a license is included, standard copyright restrictions apply; ask the repository owner before redistributing or reusing this project.
