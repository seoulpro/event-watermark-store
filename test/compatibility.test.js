import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createEventWatermarkStore } from "../index.js";
import { createMemoryEventWatermarkProvider } from "../memory.js";

test("service compatibility fixture preserves bounded state and terminal semantics", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/service-compatibility.json", import.meta.url), "utf8"),
  );
  const provider = createMemoryEventWatermarkProvider({
    stateTtlSeconds: fixture.configuration.stateTtlSeconds,
    terminalTtlSeconds: fixture.configuration.terminalTtlSeconds,
    clock: () => 0,
  });
  const store = createEventWatermarkStore({ provider });

  for (const { expectedStatus, ...transition } of fixture.transitions) {
    assert.equal((await store.transition(transition)).status, expectedStatus);
  }
  assert.deepEqual(await store.get("device-alpha"), fixture.expectedRecord);
  assert.equal(fixture.configuration.redisRequired, true);
});
