import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONTENT_TYPES } from "../src/content-types.js";

// This test never imports src/server.js: that module starts a listening
// server as a side effect of being loaded, which would make a plain "run the
// tests" hang/bind a port. CONTENT_TYPES lives in its own tiny module for
// exactly this reason.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");

function isExternal(ref) {
  return ref.startsWith("http:") || ref.startsWith("https:") || ref.startsWith("//");
}

function extractHtmlRefs(html) {
  const refs = [];
  const re = /\b(?:href|src)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!isExternal(m[1])) refs.push(m[1]);
  }
  return refs;
}

function extractJsImportSpecifiers(js) {
  const refs = [];
  // Covers `import ... from "spec"`, `import "spec"`, and dynamic `import("spec")`.
  const re = /\bimport\s*(?:[^'"();]*?from\s*)?\(?\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(js))) {
    if (!isExternal(m[1])) refs.push(m[1]);
  }
  return refs;
}

// Resolve a reference the way the browser/server actually would: a
// root-relative ref ("/app.js") is relative to PUBLIC_DIR (what the server
// treats as its document root); anything else is relative to the file that
// referenced it.
function resolveRef(ref, fromDir) {
  if (ref.startsWith("/")) return path.join(PUBLIC_DIR, ref.slice(1));
  return path.resolve(fromDir, ref);
}

test("every local asset referenced by index.html/app.js has a servable extension and exists", () => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  const appJsPath = path.join(PUBLIC_DIR, "app.js");

  const html = fs.readFileSync(indexPath, "utf8");
  const js = fs.readFileSync(appJsPath, "utf8");

  const refs = [
    ...extractHtmlRefs(html).map((ref) => ({ ref, from: PUBLIC_DIR })),
    ...extractJsImportSpecifiers(js).map((ref) => ({ ref, from: path.dirname(appJsPath) })),
  ];

  assert.ok(refs.length > 0, "expected to find at least one local asset reference");

  for (const { ref, from } of refs) {
    const ext = path.extname(ref);
    assert.ok(
      Object.hasOwn(CONTENT_TYPES, ext),
      `asset ${ref} has extension ${ext || "(none)"}, which is not in CONTENT_TYPES ` +
        `— the server would 404 it`,
    );

    const resolved = resolveRef(ref, from);
    assert.ok(
      resolved.startsWith(PUBLIC_DIR + path.sep),
      `asset ${ref} resolves outside public/: ${resolved}`,
    );
    assert.ok(
      fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
      `asset ${ref} does not exist on disk at ${resolved}`,
    );
  }
});
