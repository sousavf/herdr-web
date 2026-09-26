#!/usr/bin/env node
// Headless-Chrome smoke check for the native Herdr TUI in xterm.js.
// A live terminal connection keeps the page active, so probe the DOM over CDP
// rather than waiting for network idle or using Chrome's --dump-dom shortcut.
//
// Node built-ins only: no npm dependencies. Requires Node's native
// `WebSocket` global (Node 21+, unflagged since Node 22).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const APP_URL = process.argv[2] || "http://127.0.0.1:7717/";
const SCREENSHOT_PATH =
  process.argv[3] ||
  path.join(os.tmpdir(), `herdr-web-smoke-${Date.now()}.png`);

const CDP_PORT = 9333 + Math.floor(Math.random() * 500);
const RENDER_TIMEOUT_MS = 10_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

/** Polls Chrome's HTTP debugging endpoint until it responds or times out. */
async function waitForCdpHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Chrome CDP endpoint never came up on port ${port}: ${lastErr?.message ?? "timeout"}`,
  );
}

/** Finds the (only, freshly-opened) page target and returns its debugger URL. */
async function findPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target found via /json/list");
  return page.webSocketDebuggerUrl;
}

/** Thin CDP client: correlates command/response by id, and separately hands
 * every inbound message to an event listener (for Log.entryAdded etc). */
function makeCdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const eventListeners = [];

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of eventListeners) fn(msg.method, msg.params);
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function onEvent(fn) {
    eventListeners.push(fn);
  }

  return { send, onEvent };
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (ev) => reject(new Error(`websocket error: ${ev.message || ev}`)));
  });
}

// The probe assertions, evaluated inside the page. Kept as a single string
// literal so it runs verbatim via Runtime.evaluate.
const PROBE_EXPRESSION = `
(() => {
  const terminal = document.querySelector("#terminal .xterm");
  const rowsContainers = terminal?.querySelectorAll(".xterm-rows") || [];

  let firstSpanWidth = null;
  let firstSpanFontFamily = null;
  let totalNonWhitespace = 0;

  for (const rowsEl of rowsContainers) {
    const span = rowsEl.querySelector("span");
    if (span && firstSpanWidth === null) {
      const rect = span.getBoundingClientRect();
      firstSpanWidth = rect.width;
      firstSpanFontFamily = getComputedStyle(span).fontFamily;
    }
    const text = rowsEl.textContent || "";
    totalNonWhitespace += text.replace(/\\s/g, "").length;
  }

  return JSON.stringify({
    terminalCount: document.querySelectorAll("#terminal .xterm").length,
    rowsContainerCount: rowsContainers.length,
    firstSpanWidth,
    firstSpanFontFamily,
    totalNonWhitespace,
    connectionHidden: document.getElementById("connection")?.hidden,
  });
})()
`;

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-web-smoke-"));

  const chromeArgs = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1600,1000",
    "about:blank",
  ];

  log(`Launching Chrome: ${CHROME_PATH} ${chromeArgs.join(" ")}`);
  const chrome = spawn(CHROME_PATH, chromeArgs, { stdio: "ignore" });

  const failures = [];
  const securityLogEntries = [];

  try {
    await waitForCdpHttp(CDP_PORT, CDP_CONNECT_TIMEOUT_MS);
    const wsUrl = await findPageTarget(CDP_PORT);
    const ws = await openWebSocket(wsUrl);
    const cdp = makeCdpClient(ws);

    cdp.onEvent((method, params) => {
      if (method === "Log.entryAdded") {
        securityLogEntries.push(params.entry);
      }
    });

    await cdp.send("Log.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    log(`Navigating to ${APP_URL}`);
    await cdp.send("Page.navigate", { url: APP_URL });

    log(`Waiting up to ${RENDER_TIMEOUT_MS}ms for the native Herdr TUI to render...`);
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let probe;
    do {
      const evalResult = await cdp.send("Runtime.evaluate", {
        expression: PROBE_EXPRESSION,
        returnByValue: true,
      });
      if (evalResult.exceptionDetails) {
        throw new Error(
          `probe threw: ${evalResult.exceptionDetails.exception?.description ?? JSON.stringify(evalResult.exceptionDetails)}`,
        );
      }
      probe = JSON.parse(evalResult.result.value);
      if (probe.totalNonWhitespace > 200 && probe.firstSpanWidth > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);

    // Assertion: no security-source console/log entries (this is exactly
    // what a CSP violation surfaces as).
    const securityEntries = securityLogEntries.filter((e) => e.source === "security");
    if (securityEntries.length > 0) {
      failures.push(
        `security log entries present (${securityEntries.length}): ` +
          securityEntries.map((e) => e.text).join(" | "),
      );
    } else {
      log("PASS: no security-source log entries (CSP not blocking xterm styles)");
    }

    log(`Probe result: ${JSON.stringify(probe)}`);

    if (probe.terminalCount === 1 && probe.rowsContainerCount === 1) {
      log("PASS: found one native TUI xterm viewport");
    } else {
      failures.push(
        `expected one native TUI xterm viewport, found ${probe.terminalCount} terminals and ${probe.rowsContainerCount} row containers`,
      );
    }

    if (probe.connectionHidden === true) {
      log("PASS: terminal connection is active");
    } else {
      failures.push("terminal connection message is visible");
    }

    if (probe.firstSpanWidth !== null && probe.firstSpanWidth > 0) {
      log(`PASS: xterm row span width is ${probe.firstSpanWidth}px (> 0)`);
    } else {
      failures.push(`xterm row span width is ${probe.firstSpanWidth} (expected > 0)`);
    }

    if (
      typeof probe.firstSpanFontFamily === "string" &&
      probe.firstSpanFontFamily.toLowerCase().includes("mono")
    ) {
      log(`PASS: xterm row span font-family is monospace ("${probe.firstSpanFontFamily}")`);
    } else {
      failures.push(
        `xterm row span font-family "${probe.firstSpanFontFamily}" does not contain "mono"`,
      );
    }

    if (probe.totalNonWhitespace > 200) {
      log(`PASS: ${probe.totalNonWhitespace} non-whitespace characters rendered (> 200)`);
    } else {
      failures.push(
        `only ${probe.totalNonWhitespace} non-whitespace characters rendered (expected > 200; terminal is blank or mostly blank)`,
      );
    }

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
    log(`Screenshot written to ${SCREENSHOT_PATH}`);
  } catch (err) {
    failures.push(`smoke check error: ${err.message}`);
  } finally {
    chrome.kill("SIGKILL");
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }

  log("");
  if (failures.length === 0) {
    log("SMOKE CHECK: PASS");
    process.exit(0);
  } else {
    log("SMOKE CHECK: FAIL");
    for (const f of failures) log(`  - ${f}`);
    process.exit(1);
  }
}

main();
