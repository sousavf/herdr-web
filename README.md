# herdr-web

A local browser view of [Herdr](https://herdr.dev), the terminal workspace
manager for AI coding agents. The page runs Herdr's native terminal client in
one full-window [xterm.js](https://github.com/xtermjs/xterm.js) view. Herdr draws
its own sidebar, tabs, panes, menus, cursor, and configured theme; herdr-web
does not reconstruct those screens from socket snapshots.

## Requirements

- Node.js 18 or newer
- Herdr installed and on `PATH`
- An existing running Herdr server (`herdr status server`)

## Quick start

```bash
git clone https://github.com/sousavf/herdr-web.git
cd herdr-web
npm install
npm start
```

Open <http://127.0.0.1:7717/> in a local browser. Herdr must already be
running; opening the page does not start a Herdr server. If it is unavailable,
the page shows a connection message and retries.

## How it works

```text
Browser xterm.js ↔ WebSocket /api/terminal ↔ herdr-web on 127.0.0.1
                                             ↕ node-pty
                                        native herdr client
                                             ↕
                                        existing Herdr server
```

The browser forwards terminal input, paste, and mouse sequences to one native
Herdr client. Terminal output returns over the same WebSocket. Resizing the
browser resizes the PTY, so Herdr redraws its own layout. Each browser tab
attaches a separate Herdr client and follows Herdr's normal multiple-client
focus and sizing behavior. Closing a browser tab detaches its client; it does
not stop the Herdr server.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to bind. Set to `0.0.0.0` to listen on all IPv4 interfaces, or use a specific interface address. |
| `PORT` | `7717` | HTTP port |
| `PUBLIC_ORIGIN` | unset | Optional public HTTP(S) origin for a reverse proxy. It must be an origin only, with no credentials, path, query, or fragment. |
| `HERDR_BIN_PATH` | `herdr` on `PATH` | Herdr executable used for the status probe and terminal client |

The Herdr status probe and native client inherit the server process's Herdr
environment. Set Herdr's own variables before `npm start` when using a custom
configuration, named session, or socket (for example, `HERDR_CONFIG_PATH` or
`HERDR_SOCKET_PATH` where supported by your Herdr installation). Herdr's
configuration remains authoritative for its theme and keybindings.

## Security

The browser controls a live terminal as the user running `herdr-web`. Anyone
who can access it can type commands, create or close Herdr workspaces, and
perform other actions available in Herdr's TUI. Treat this port like local
shell access.

By default, the HTTP server binds only to `127.0.0.1`; requests must arrive
from loopback and use the expected `Host`. WebSocket upgrades require the
matching `Origin`. When bound to `0.0.0.0`, the server accepts clients from
other machines only when the `Host` is one of the machine's current
non-internal IPv4 addresses. It rejects arbitrary hostnames to reduce DNS
rebinding risk, and still requires an exact matching WebSocket `Origin`.

**Warning:** `HOST=0.0.0.0` exposes a live shell to the LAN with no
authentication. Anyone on a network that can reach the port can type commands
as the user running `herdr-web`. Use it only on a trusted network. Do not
expose the port through a proxy or tunnel without adding authentication.
Other local accounts may also be able to reach a loopback TCP port. Terminal
content is rendered by xterm.js, not inserted as HTML, and is not logged by
the bridge.

For a reverse proxy or Cloudflare Tunnel, set the exact public origin and
protect that hostname with an authentication layer such as Cloudflare Access.
For example:

```bash
HOST=0.0.0.0 PUBLIC_ORIGIN=https://herdr.example.com npm start
```

Configure the proxy to forward that hostname to herdr-web's HTTP port and
require an Access policy before allowing traffic through. `PUBLIC_ORIGIN`
allows only that exact `Host` and matching WebSocket `Origin`; it does not
provide authentication itself.

## Limits

- The interactive text TUI works in the browser, including Herdr's own
  keyboard and mouse controls. Kitty in-pane images are not supported by this
  xterm.js view.
- Browser-reserved shortcuts may be intercepted before Herdr receives them.
  Use the terminal menu or a native Herdr client for those shortcuts.
- Herdr wraps full-screen redraws in DEC 2026 synchronized-output blocks.
  xterm.js 6.0.0 can stall under a continuous stream of those blocks, so the
  browser client ignores that mode until the upstream renderer is fixed. This
  keeps typing responsive but may briefly expose a partially drawn frame.

## Verification

Run `npm test` and `npm run check` for local automated checks. With a running
Herdr server and herdr-web, `npm run smoke` opens headless Chrome, checks that
the native terminal renders visible glyphs and substantial content without
CSP violations, and writes a screenshot in the system temporary directory.
Pass a URL and optional screenshot path with
`npm run smoke -- <url> [screenshot-path]`. The smoke
check needs Chrome and Node's native `WebSocket` global (Node 21+); it is not
run in CI because CI has no live Herdr session.

## Dependencies

`node-pty@1.1.0` runs the native Herdr terminal client in a PTY and
`ws@8.21.3` provides the local WebSocket bridge. The browser renderer,
`@xterm/xterm` 6.0.0, is vendored in `public/vendor/xterm/` and requires no
CDN or build step. xterm.js is MIT licensed; see its vendored CSS copyright
header.

On macOS, the install hook restores the executable bits missing from
`node-pty@1.1.0`'s packaged `spawn-helper`; without them, PTY startup fails
with `posix_spawnp failed`.

## License

MIT
