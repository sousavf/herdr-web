// Extension allowlist for serveStatic in server.js. An extension missing here
// is a 404, even if the file exists on disk — see test/assets.test.js, which
// checks every asset app.js/index.html reference against this map.
export const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
