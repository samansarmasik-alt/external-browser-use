# External Browser Use

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets AI agents operate a real, visible Chromium browser. It is built for practical browser work: inspect pages, choose reliable targets, click, type, drag, use the keyboard, and verify what happened.

The browser uses a persistent local profile, so sign-ins and site state can survive restarts. The server listens on loopback only and protects its HTTP MCP endpoint with a locally generated token.

## Highlights

- Visible Chromium controlled through Playwright.
- Screenshot, page state, readable page content, and clickable-element coordinates.
- Semantic targeting by accessible role/name, label, placeholder, test ID, or CSS selector; coordinates are available when needed.
- Mouse move and buttons, keyboard press/down/up, typing, wheel scrolling, and real drag-and-drop.
- Ordered action sequences (up to 200 steps) with partial-progress and failed-step reporting.
- Tab creation, listing, switching, and closing; wait for selectors, text, or URL changes.
- Persistent profile and optional cookie import. Cookie values are not returned in tool results or status output.
- Windows terminal menu for server state, agent integrations, and optional startup-on-login.

## Requirements

- Windows for the included management menu, startup integration, and one-key agent setup.
- Node.js 20 or newer and npm.
- Codex, OpenCode, and/or CommandCode installed if you want the manager to configure those clients.

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

The manager registers the local server with supported agents using Streamable HTTP. The default endpoint is `http://127.0.0.1:7331/mcp`; the port can be changed with `BROWSER_MCP_PORT`. The listener is bound to `127.0.0.1`, not exposed to the local network.

The server creates an access token in `%LOCALAPPDATA%\local-browser-mcp\token` on first start. The setup command configures agent clients to use the local connection. Keep this token private; do not commit it, paste it into prompts, or share it in logs. If configuring a client manually, use the token as a bearer credential and never put its value in a checked-in config file.

## Browser tools

The MCP server exposes these tools:

| Area | Tools | Purpose |
| --- | --- | --- |
| Start and inspect | `browser_start`, `browser_status`, `browser_observe`, `browser_screenshot`, `browser_page_content`, `browser_clickable_elements` | Start the browser; inspect page state, screenshots, text, and actionable coordinates. |
| Navigate and wait | `browser_open`, `browser_wait` | Open an HTTP(S) URL and wait for a selector, text, URL fragment, or duration. |
| Find and interact | `browser_click`, `browser_type`, `browser_keypress`, `browser_keyboard`, `browser_mouse_move`, `browser_mouse_button`, `browser_drag`, `browser_actions`, `browser_release_inputs`, `browser_mcp_pointer` | Use semantic locators or coordinates; perform individual or ordered mouse/keyboard actions and release held inputs. |
| Tabs | `browser_tabs`, `browser_new_tab`, `browser_switch_tab`, `browser_close_tab` | List and manage open tabs. Browser actions operate on the active tab. |
| Profile and cookies | `browser_import_cookies`, `browser_cookie_names`, `browser_save_profile`, `browser_close` | Import cookies, inspect cookie names without values, save the profile, or close the browser. |

Prefer semantic locators (for example, a button's accessible role and name) when available: they are generally more robust than screen coordinates. Use `browser_observe` or `browser_clickable_elements` to inspect coordinates when a page has canvas/game controls or no useful accessible elements. `browser_actions` can chain up to 200 steps; if a step fails, the result reports completed steps and the failing action. `browser_release_inputs` is available to recover from a held mouse button or key.

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

When idle, the local MCP service is lightweight; actual CPU and memory use depends on Chromium, the number of tabs, and the pages being controlled. No fixed CPU or RAM percentage is guaranteed, particularly while a browser page is active.

## License

No license has been added yet. Unless a license is included, standard copyright restrictions apply; ask the repository owner before redistributing or reusing this project.
