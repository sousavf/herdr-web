import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { attachTerminalSession } from "../src/terminal-session.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages = [];
  closeCode = null;

  send(payload, callback) {
    this.messages.push(JSON.parse(payload));
    setImmediate(() => callback(null));
  }

  close(code) {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  receive(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

class FakePty {
  inputs = [];
  resizes = [];
  killed = false;
  paused = false;

  onData(handler) {
    this.dataHandler = handler;
  }

  onExit(handler) {
    this.exitHandler = handler;
  }

  write(data) {
    this.inputs.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  kill() {
    this.killed = true;
  }
}

test("native client uses the existing session and forwards ordered terminal data", async () => {
  const socket = new FakeSocket();
  const terminal = new FakePty();
  let spawnArgs;
  attachTerminalSession(socket, {
    probe: async () => {},
    spawnPty: (...args) => {
      spawnArgs = args;
      return terminal;
    },
    binary: "/usr/local/bin/herdr",
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/tmp/existing-herdr.sock",
      HERDR_SESSION: "work",
    },
    cwd: "/tmp",
  });

  socket.receive({ type: "input", data: "a" });
  socket.receive({ type: "resize", cols: 100, rows: 30 });
  await new Promise(setImmediate);

  assert.equal(spawnArgs[0], "/usr/local/bin/herdr");
  assert.deepEqual(spawnArgs[1], []);
  assert.equal(spawnArgs[2].cols, 100);
  assert.equal(spawnArgs[2].rows, 30);
  assert.equal(spawnArgs[2].env.HERDR_SOCKET_PATH, "/tmp/existing-herdr.sock");
  assert.equal(spawnArgs[2].env.HERDR_SESSION, "work");
  assert.equal(spawnArgs[2].env.HERDR_ENV, undefined);
  assert.equal(spawnArgs[2].env.HERDR_PANE_ID, undefined);
  assert.deepEqual(terminal.inputs, ["a"]);

  socket.receive({ type: "input", data: "b" });
  socket.receive({ type: "resize", cols: 120, rows: 40 });
  terminal.dataHandler("\x1b[31mhello");
  assert.deepEqual(terminal.inputs, ["a", "b"]);
  assert.deepEqual(terminal.resizes, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(socket.messages.at(-1), { type: "output", data: "\x1b[31mhello" });

  socket.close(1000);
  assert.equal(terminal.killed, true);
});

test("missing Herdr server reports an error without spawning a client", async () => {
  const socket = new FakeSocket();
  let spawned = false;
  attachTerminalSession(socket, {
    probe: async () => { throw new Error("server is stopped"); },
    spawnPty: () => { spawned = true; },
  });
  socket.receive({ type: "resize", cols: 80, rows: 24 });
  await new Promise(setImmediate);

  assert.equal(spawned, false);
  assert.match(socket.messages[0].message, /server is stopped/);
  assert.equal(socket.closeCode, 1011);
});

test("invalid size and oversized input are rejected", () => {
  for (const message of [
    { type: "resize", cols: 0, rows: 24 },
    { type: "resize", cols: 80, rows: 201 },
    { type: "input", data: "x".repeat(65537) },
    { type: "command", data: "herdr server stop" },
  ]) {
    const socket = new FakeSocket();
    attachTerminalSession(socket, { probe: async () => {} });
    socket.receive(message);
    assert.equal(socket.closeCode, 1008);
  }
});

test("slow browser output pauses and resumes its PTY", async () => {
  const socket = new FakeSocket();
  const terminal = new FakePty();
  attachTerminalSession(socket, {
    probe: async () => {},
    spawnPty: () => terminal,
  });
  socket.receive({ type: "resize", cols: 80, rows: 24 });
  await new Promise(setImmediate);

  socket.bufferedAmount = 1024 * 1024 + 1;
  terminal.dataHandler("output");
  assert.equal(terminal.paused, true);
  socket.bufferedAmount = 0;
  await new Promise(setImmediate);
  assert.equal(terminal.paused, false);
  socket.close(1000);
});
