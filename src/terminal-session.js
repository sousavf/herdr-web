import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pty from "node-pty";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

const INITIAL_SIZE_TIMEOUT_MS = 5_000;
const MAX_INPUT_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;

function clientEnvironment(source) {
  const env = { ...source, TERM: "xterm-256color", COLORTERM: "truecolor" };

  // A web server launched from inside a Herdr pane must attach a new outer
  // client, rather than inherit markers that make the client appear nested.
  for (const key of Object.keys(env)) {
    if (
      key === "HERDR_ENV" ||
      key === "HERDR_PANE_ID" ||
      key === "HERDR_TAB_ID" ||
      key === "HERDR_WORKSPACE_ID" ||
      key.startsWith("HERDR_ACTIVE_")
    ) {
      delete env[key];
    }
  }
  return env;
}

async function probeServer(binary, env) {
  const { stdout } = await execFileAsync(binary, ["status", "server", "--json"], {
    env,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const status = JSON.parse(stdout);
  if (status.status !== "running") {
    throw new Error("Herdr is not running. Start Herdr, then reconnect.");
  }
}

function validSize(message) {
  return (
    Number.isInteger(message.cols) &&
    message.cols >= 2 &&
    message.cols <= 500 &&
    Number.isInteger(message.rows) &&
    message.rows >= 1 &&
    message.rows <= 200
  );
}

/** Attach one browser socket to one native Herdr terminal client. */
export function attachTerminalSession(
  socket,
  {
    spawnPty = pty.spawn,
    probe = probeServer,
    binary = process.env.HERDR_BIN_PATH || "herdr",
    environment = process.env,
    cwd = process.cwd(),
  } = {},
) {
  const env = clientEnvironment(environment);
  let terminal = null;
  let starting = false;
  let stopped = false;
  let paused = false;
  let latestSize = null;
  const pendingInput = [];
  let pendingInputBytes = 0;

  function send(type, fields = {}) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type, ...fields }), (error) => {
      if (error) {
        socket.close(1011, "terminal transport failed");
      } else if (paused && terminal && socket.bufferedAmount < LOW_WATER_BYTES) {
        terminal.resume();
        paused = false;
      }
    });
    if (!paused && terminal && socket.bufferedAmount > HIGH_WATER_BYTES) {
      terminal.pause();
      paused = true;
    }
  }

  function fail(message) {
    send("error", { message });
    socket.close(1011, "terminal unavailable");
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(sizeTimer);
    if (terminal) {
      terminal.kill();
      terminal = null;
    }
  }

  async function start() {
    if (starting || terminal || stopped || !latestSize) return;
    starting = true;
    clearTimeout(sizeTimer);
    try {
      await probe(binary, env);
      if (stopped) return;
      terminal = spawnPty(binary, [], {
        name: "xterm-256color",
        cols: latestSize.cols,
        rows: latestSize.rows,
        cwd,
        env,
      });
      terminal.onData((data) => send("output", { data }));
      terminal.onExit(({ exitCode }) => {
        terminal = null;
        send("exit", { code: Number.isInteger(exitCode) ? exitCode : null });
        socket.close(1000, "Herdr client exited");
      });
      for (const input of pendingInput) terminal.write(input);
      pendingInput.length = 0;
      pendingInputBytes = 0;
    } catch (error) {
      if (!stopped) fail(`Could not attach to Herdr: ${error.message}`);
    }
  }

  const sizeTimer = setTimeout(
    () => fail("Terminal size was not received. Reconnect and try again."),
    INITIAL_SIZE_TIMEOUT_MS,
  );

  socket.on("message", (bytes, isBinary) => {
    if (stopped || isBinary) {
      socket.close(1008, "invalid terminal message");
      return;
    }
    let message;
    try {
      message = JSON.parse(bytes.toString("utf8"));
    } catch {
      socket.close(1008, "invalid terminal message");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      socket.close(1008, "invalid terminal message");
      return;
    }
    if (message.type === "resize" && validSize(message)) {
      latestSize = { cols: message.cols, rows: message.rows };
      if (terminal) terminal.resize(message.cols, message.rows);
      else void start();
      return;
    }
    if (
      message.type === "input" &&
      typeof message.data === "string" &&
      message.data.length > 0 &&
      Buffer.byteLength(message.data) <= MAX_INPUT_BYTES
    ) {
      if (terminal) terminal.write(message.data);
      else {
        pendingInputBytes += Buffer.byteLength(message.data);
        if (pendingInputBytes > MAX_INPUT_BYTES) {
          socket.close(1009, "too much pending input");
          return;
        }
        pendingInput.push(message.data);
      }
      return;
    }
    socket.close(1008, "invalid terminal message");
  });

  socket.on("close", stop);
  socket.on("error", stop);
  return stop;
}
