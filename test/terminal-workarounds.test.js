import assert from "node:assert/strict";
import test from "node:test";

import { registerSynchronizedOutputWorkaround } from "../public/terminal-workarounds.js";

test("consumes only exact private synchronized-output mode sequences", () => {
  const handlers = new Map();
  const terminal = {
    parser: {
      registerCsiHandler(identifier, handler) {
        handlers.set(`${identifier.prefix}${identifier.final}`, handler);
      },
    },
  };

  registerSynchronizedOutputWorkaround(terminal);

  assert.deepEqual([...handlers.keys()].sort(), ["?h", "?l"]);
  for (const handler of handlers.values()) assert.equal(handler([2026]), true);
  for (const handler of handlers.values()) {
    for (const params of [[], [25], [2026, 25], [25, 2026], ["2026"], null]) {
      assert.equal(handler(params), false);
    }
  }
});
