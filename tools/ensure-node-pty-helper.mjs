import { chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXECUTABLE_BITS = 0o111;

export async function ensureNodePtyHelper({
  platform = process.platform,
  arch = process.arch,
  projectRoot = resolve(dirname(SCRIPT_PATH), ".."),
} = {}) {
  if (platform !== "darwin") return;

  const helperPath = resolve(
    projectRoot,
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${arch}`,
    "spawn-helper",
  );

  try {
    const { mode } = await stat(helperPath);
    const permissions = mode & 0o7777;
    if ((permissions & EXECUTABLE_BITS) !== EXECUTABLE_BITS) {
      await chmod(helperPath, permissions | EXECUTABLE_BITS);
    }
  } catch (error) {
    throw new Error(
      `Could not prepare node-pty spawn helper at ${helperPath}: ${error.message}`,
      { cause: error },
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await ensureNodePtyHelper();
}
