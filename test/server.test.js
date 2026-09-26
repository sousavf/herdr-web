import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import {
  allowsWebSocketUpgrade,
  createAppServer,
  createHostAccessPolicy,
  parsePublicOrigin,
  webSocketOrigins,
} from "../src/server.js";

test("default host policy allows loopback only", () => {
  const policy = createHostAccessPolicy({ host: "127.0.0.1", port: 7717 });

  assert.equal(policy.allowRemoteClients, false);
  assert.deepEqual([...policy.allowedHosts].sort(), [
    "127.0.0.1:7717",
    "localhost:7717",
  ]);
});

test("configured LAN host accepts only matching host and WebSocket origin", () => {
  const policy = createHostAccessPolicy({
    host: "0.0.0.0",
    port: 7717,
    networkInterfaces: () => ({
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false },
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
    }),
  });
  const lanHost = "192.168.1.42:7717";

  assert.equal(policy.allowRemoteClients, true);
  assert.equal(
    allowsWebSocketUpgrade({
      policy,
      host: lanHost,
      origin: `http://${lanHost}`,
      url: "/api/terminal",
    }),
    true,
  );
  assert.equal(
    allowsWebSocketUpgrade({
      policy,
      host: "attacker.example:7717",
      origin: "http://attacker.example:7717",
      url: "/api/terminal",
    }),
    false,
  );
  assert.equal(
    allowsWebSocketUpgrade({
      policy,
      host: lanHost,
      origin: "http://attacker.example",
      url: "/api/terminal",
    }),
    false,
  );
});

test("a specific non-loopback bind address is allowed with loopback hosts", () => {
  const policy = createHostAccessPolicy({ host: "192.168.1.42", port: 7717 });

  assert.equal(policy.allowRemoteClients, true);
  assert.deepEqual([...policy.allowedHosts].sort(), [
    "127.0.0.1:7717",
    "192.168.1.42:7717",
    "localhost:7717",
  ]);
});

test("PUBLIC_ORIGIN allows its exact HTTPS Host and Origin pair", () => {
  const policy = createHostAccessPolicy({
    host: "0.0.0.0",
    port: 7717,
    publicOrigin: "https://herdr.example.com",
    networkInterfaces: () => ({}),
  });

  assert.equal(policy.allowedHosts.has("herdr.example.com"), true);
  assert.ok(webSocketOrigins(policy).includes("wss://herdr.example.com"));
  assert.equal(
    allowsWebSocketUpgrade({
      policy,
      host: "herdr.example.com",
      origin: "https://herdr.example.com",
      url: "/api/terminal",
    }),
    true,
  );
  assert.equal(
    allowsWebSocketUpgrade({
      policy,
      host: "herdr.example.com",
      origin: "http://herdr.example.com",
      url: "/api/terminal",
    }),
    false,
  );
  assert.equal(
    allowsWebSocketUpgrade({
      policy,
      host: "herdr.example.com",
      origin: "https://foreign.example",
      url: "/api/terminal",
    }),
    false,
  );
});

test("PUBLIC_ORIGIN rejects credentials, paths, queries, fragments, and non-HTTP schemes", () => {
  const credentialedOrigin = new URL("https://herdr.example.com");
  credentialedOrigin.username = "user";
  credentialedOrigin.password = "pass";
  for (const origin of [
    credentialedOrigin.href,
    "https://herdr.example.com/path",
    "https://herdr.example.com?mode=unsafe",
    "https://herdr.example.com#fragment",
    "ftp://herdr.example.com",
  ]) {
    assert.throws(() => parsePublicOrigin(origin), /PUBLIC_ORIGIN/);
  }
});

async function startServer(t, attach = () => {}) {
  const { server, webSockets } = createAppServer({ attach });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of webSockets.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => webSockets.close(resolve));
  });
  return server.address().port;
}

function openSocket(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, { origin });
    const firstMessage = new Promise((messageResolve) => socket.once("message", messageResolve));
    socket.once("open", () => resolve({ socket, firstMessage }));
    socket.once("error", reject);
  });
}

function rejectedUpgrade(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`,
      origin === undefined ? {} : { origin });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", reject);
  });
}

test("same-origin browser can open the terminal transport", { timeout: 5000 }, async (t) => {
  const port = await startServer(t, (socket) => {
    socket.send(JSON.stringify({ type: "output", data: "native Herdr" }));
  });
  const { socket, firstMessage } = await openSocket(port, `http://127.0.0.1:${port}`);
  const message = await firstMessage;
  assert.deepEqual(JSON.parse(message.toString()), { type: "output", data: "native Herdr" });
  socket.close();
});

test("foreign and missing WebSocket origins are refused", { timeout: 5000 }, async (t) => {
  const port = await startServer(t);
  assert.equal(await rejectedUpgrade(port, "http://evil.example"), 403);
  assert.equal(await rejectedUpgrade(port), 403);
});

test("static page is served but old control API is gone", { timeout: 5000 }, async (t) => {
  const port = await startServer(t);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src.*ws:\/\/127\.0\.0\.1/);
  assert.match(await page.text(), /Herdr terminal/);

  const oldApi = await fetch(`http://127.0.0.1:${port}/api/call`, { method: "POST" });
  assert.equal(oldApi.status, 405);
});
