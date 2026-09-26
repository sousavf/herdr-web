import { Terminal } from "./vendor/xterm/xterm.mjs";
import { registerSynchronizedOutputWorkaround } from "./terminal-workarounds.js";

const FONT_FAMILY =
  '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.2;
const MAX_INPUT_CHUNK = 8192;
const MAX_RETRY_DELAY = 10000;

const host = document.getElementById("terminal");
const connection = document.getElementById("connection");
const connectionMessage = document.getElementById("connection-message");
const retryButton = document.getElementById("retry");
const terminal = new Terminal({
  cols: 80,
  rows: 24,
  cursorBlink: true,
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  lineHeight: LINE_HEIGHT,
  scrollback: 1000,
  screenReaderMode: true,
});
registerSynchronizedOutputWorkaround(terminal);
terminal.open(host);

let socket = null;
let retryTimer = null;
let retryDelay = 1000;
let resizeFrame = null;
let dimensions = { cols: 80, rows: 24 };
let failureMessage = null;

function showConnection(message, canRetry = false) {
  connectionMessage.textContent = message;
  retryButton.hidden = !canRetry;
  connection.hidden = false;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function cellSize() {
  const screen = host.querySelector(".xterm-screen");
  if (screen) {
    const rect = screen.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { width: rect.width / terminal.cols, height: rect.height / terminal.rows };
    }
  }

  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${FONT_FAMILY};line-height:${LINE_HEIGHT}`;
  host.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { width: rect.width / 10, height: rect.height };
}

function resizeTerminal() {
  resizeFrame = null;
  const { width, height } = cellSize();
  const box = host.getBoundingClientRect();
  if (!width || !height || !box.width || !box.height) return;

  const cols = Math.max(2, Math.min(500, Math.floor(box.width / width)));
  const rows = Math.max(1, Math.min(200, Math.floor(box.height / height)));
  if (cols !== dimensions.cols || rows !== dimensions.rows) {
    dimensions = { cols, rows };
    terminal.resize(cols, rows);
    send({ type: "resize", cols, rows });
  }
}

function scheduleResize() {
  if (resizeFrame === null) resizeFrame = requestAnimationFrame(resizeTerminal);
}

function scheduleReconnect() {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  showConnection("Connecting to Herdr…");
  failureMessage = null;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const connectionSocket = new WebSocket(`${protocol}//${location.host}/api/terminal`);
  socket = connectionSocket;

  connectionSocket.addEventListener("open", () => {
    if (socket !== connectionSocket) return;
    retryDelay = 1000;
    terminal.reset();
    resizeTerminal();
    send({ type: "resize", ...dimensions });
    connection.hidden = true;
    terminal.focus();
  });

  connectionSocket.addEventListener("message", (event) => {
    if (socket !== connectionSocket || typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      failureMessage = "Received an invalid response from Herdr.";
      showConnection(failureMessage, true);
      return;
    }
    if (message.type === "output" && typeof message.data === "string") {
      terminal.write(message.data);
    } else if (message.type === "error" && typeof message.message === "string") {
      failureMessage = message.message;
      showConnection(failureMessage, true);
    } else if (message.type === "exit") {
      failureMessage = "Herdr client exited.";
      showConnection(failureMessage, true);
    }
  });

  connectionSocket.addEventListener("close", () => {
    if (socket !== connectionSocket) return;
    socket = null;
    showConnection(`${failureMessage || "Herdr connection lost."} Reconnecting…`, true);
    scheduleReconnect();
  });

  connectionSocket.addEventListener("error", () => {
    if (socket === connectionSocket && !failureMessage) {
      failureMessage = "Could not connect to Herdr.";
      showConnection(failureMessage, true);
    }
  });
}

terminal.onData((data) => {
  for (let index = 0; index < data.length;) {
    let end = Math.min(index + MAX_INPUT_CHUNK, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end++;
    send({ type: "input", data: data.slice(index, end) });
    index = end;
  }
});

new ResizeObserver(scheduleResize).observe(host);
window.addEventListener("resize", scheduleResize);
document.fonts?.ready.then(scheduleResize);
retryButton.addEventListener("click", () => {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  connect();
});

scheduleResize();
connect();
