import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureNodePtyHelper } from "../tools/ensure-node-pty-helper.mjs";

async function createHelperFixture(t, arch = "arm64") {
  const projectRoot = await mkdtemp(join(tmpdir(), "node-pty-helper-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  const helperPath = join(
    projectRoot,
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${arch}`,
    "spawn-helper",
  );
  await mkdir(join(helperPath, ".."), { recursive: true });
  await writeFile(helperPath, "fixture");
  return { projectRoot, helperPath };
}

test("Darwin postinstall adds executable bits while preserving other permissions", async (t) => {
  const { projectRoot, helperPath } = await createHelperFixture(t);
  await chmod(helperPath, 0o644);

  await ensureNodePtyHelper({ platform: "darwin", arch: "arm64", projectRoot });

  assert.equal((await stat(helperPath)).mode & 0o777, 0o755);
});

test("Darwin postinstall preserves an already-executable helper mode", async (t) => {
  const { projectRoot, helperPath } = await createHelperFixture(t);
  await chmod(helperPath, 0o755);

  await ensureNodePtyHelper({ platform: "darwin", arch: "arm64", projectRoot });

  assert.equal((await stat(helperPath)).mode & 0o777, 0o755);
});

test("postinstall is a no-op off Darwin", async (t) => {
  const { projectRoot } = await createHelperFixture(t);
  await rm(join(projectRoot, "node_modules"), { recursive: true });

  await assert.doesNotReject(
    ensureNodePtyHelper({ platform: "linux", arch: "x64", projectRoot }),
  );
});
