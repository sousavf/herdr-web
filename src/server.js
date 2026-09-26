#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { CONTENT_TYPES } from "./content-types.js";
import { attachTerminalSession } from "./terminal-session.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const DEFAULT_PORT = 7717;
const MAX_CLIENTS = 4;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function hostWithPort(host, port) {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${authority}:${port}`;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function parsePublicOrigin(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) {
    throw new TypeError("PUBLIC_ORIGIN must be an absolute HTTP(S) origin without a path");
  }

  let origin;
  try {
    origin = new URL(value);
  } catch (error) {
    throw new TypeError("PUBLIC_ORIGIN must be a valid absolute HTTP(S) origin", { cause: error });
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !origin.hostname ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError("PUBLIC_ORIGIN must be an absolute HTTP(S) origin without credentials or path");
  }
  return origin;
}

/** Build the request allowlist for the configured bind address and port. */
export function createHostAccessPolicy({
  host = "127.0.0.1",
  port,
  publicOrigin: publicOriginValue,
  networkInterfaces = os.networkInterfaces,
} = {}) {
  const allowedHosts = new Set();
  const allowedOriginsByHost = new Map();
  const allowPair = (requestHost, origin) => {
    allowedHosts.add(requestHost);
    const origins = allowedOriginsByHost.get(requestHost) || new Set();
    origins.add(origin);
    allowedOriginsByHost.set(requestHost, origins);
  };
  const loopbackHosts = [hostWithPort("127.0.0.1", port), hostWithPort("localhost", port)];
  for (const loopbackHost of loopbackHosts) {
    allowPair(loopbackHost, `http://${loopbackHost}`);
  }
  if (host === "0.0.0.0") {
    for (const interfaces of Object.values(networkInterfaces())) {
      for (const networkInterface of interfaces || []) {
        if (
          !networkInterface.internal &&
          (networkInterface.family === "IPv4" || networkInterface.family === 4)
        ) {
          const interfaceHost = hostWithPort(networkInterface.address, port);
          allowPair(interfaceHost, `http://${interfaceHost}`);
        }
      }
    }
  } else {
    const bindHost = hostWithPort(host, port);
    allowPair(bindHost, `http://${bindHost}`);
  }

  const publicOrigin = parsePublicOrigin(publicOriginValue);
  if (publicOrigin) {
    allowPair(publicOrigin.host, publicOrigin.origin);
  }

  return {
    allowedHosts,
    allowedOriginsByHost,
    allowedOrigins: new Set([...allowedOriginsByHost.values()].flatMap((origins) => [...origins])),
    allowRemoteClients: host === "0.0.0.0" || !isLoopbackHost(host),
  };
}

export function allowsWebSocketUpgrade({ policy, host, origin, url }) {
  return (
    policy.allowedHosts.has(host) &&
    policy.allowedOriginsByHost.get(host)?.has(origin) === true &&
    url === "/api/terminal"
  );
}

export function webSocketOrigins(policy) {
  return [...policy.allowedOrigins].map((origin) => {
    const parsedOrigin = new URL(origin);
    return `${parsedOrigin.protocol === "https:" ? "wss:" : "ws:"}//${parsedOrigin.host}`;
  });
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function serveStatic(res, pathname, policy) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  const type = CONTENT_TYPES[path.extname(filePath)];
  if (relative.includes("..") || !filePath.startsWith(PUBLIC_DIR + path.sep) || !type) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const headers = {
      "Content-Type": type,
      "Content-Length": data.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    };
    if (type.startsWith("text/html")) {
      const connectOrigins = webSocketOrigins(policy).join(" ");
      headers["Content-Security-Policy"] =
        `default-src 'self'; style-src 'self' 'unsafe-inline'; ` +
        `connect-src 'self' ${connectOrigins}`;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

/** Create the local HTTP and WebSocket server without binding a port. */
export function createAppServer({
  attach = attachTerminalSession,
  host = "127.0.0.1",
  publicOrigin,
  networkInterfaces = os.networkInterfaces,
} = {}) {
  parsePublicOrigin(publicOrigin);
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const server = http.createServer((req, res) => {
    const port = server.address()?.port || DEFAULT_PORT;
    const policy = createHostAccessPolicy({ host, port, publicOrigin, networkInterfaces });
    if (!policy.allowRemoteClients && !isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: "local access only" });
      return;
    }
    const requestHost = req.headers.host;
    if (!policy.allowedHosts.has(requestHost)) {
      sendJson(res, 403, { error: "invalid host" });
      return;
    }

    let pathname;
    try {
      ({ pathname } = new URL(req.url, `http://127.0.0.1:${port}`));
    } catch {
      sendJson(res, 400, { error: "invalid URL" });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    serveStatic(res, pathname, policy);
  });

  server.on("upgrade", (req, socket, head) => {
    const port = server.address()?.port || DEFAULT_PORT;
    const policy = createHostAccessPolicy({ host, port, publicOrigin, networkInterfaces });
    if (!policy.allowRemoteClients && !isLoopback(req.socket.remoteAddress)) {
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }
    const requestHost = req.headers.host;
    const origin = req.headers.origin;
    if (!allowsWebSocketUpgrade({ policy, host: requestHost, origin, url: req.url })) {
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }
    if (webSockets.clients.size >= MAX_CLIENTS) {
      rejectUpgrade(socket, "503 Service Unavailable");
      return;
    }
    webSockets.handleUpgrade(req, socket, head, (client) => {
      webSockets.emit("connection", client, req);
    });
  });

  webSockets.on("connection", (client) => attach(client));
  return { server, webSockets };
}

const isEntrypoint = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || "127.0.0.1";
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  const { server, webSockets } = createAppServer({ host, publicOrigin });
  server.listen(port, host, () => {
    console.log(`herdr-web listening on http://${hostWithPort(host, port)}`);
  });

  const shutdown = () => {
    for (const client of webSockets.clients) client.close(1001, "server shutting down");
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
