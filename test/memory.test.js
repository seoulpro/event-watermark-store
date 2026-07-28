import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationIdConflictError,
  createEventWatermarkStore,
} from "../index.js";
import { createMemoryEventWatermarkProvider } from "../memory.js";

const permutations = (items) => {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, candidate) => candidate !== index)).map((rest) => [item, ...rest]),
  );
};

const makeStore = (options = {}) => {
  const provider = createMemoryEventWatermarkProvider(options);
  return { provider, store: createEventWatermarkStore({ provider, clock: options.clock }) };
};

test("memory provider implements refresh, terminal barrier, and later recovery", async () => {
  const { store } = makeStore({ clock: () => 1000 });

  assert.equal(
    (await store.transition({ key: "sensor", kind: "upsert", eventTime: 10, value: { n: 1 } })).status,
    "applied",
  );
  assert.equal(
    (await store.transition({ key: "sensor", kind: "upsert", eventTime: 10, value: { n: 2 } })).status,
    "refreshed",
  );
  assert.deepEqual((await store.get("sensor"))?.value, { n: 2 });
  assert.equal(
    (await store.transition({ key: "sensor", kind: "terminal", eventTime: 10, reason: "ended" })).status,
    "applied",
  );
  assert.equal(
    (await store.transition({ key: "sensor", kind: "upsert", eventTime: 10, value: { n: 3 } })).status,
    "blocked-by-terminal",
  );
  assert.equal(
    (await store.transition({ key: "sensor", kind: "upsert", eventTime: 11, value: { n: 4 } })).status,
    "applied",
  );
  assert.deepEqual(await store.get("sensor"), {
    key: "sensor",
    kind: "upsert",
    eventTime: 11,
    receivedAt: 1000,
    value: { n: 4 },
  });
});

test("equal-time terminal wins in either concurrent invocation order", async () => {
  for (const order of ["upsert-first", "terminal-first"]) {
    const { store } = makeStore({ clock: () => 100 });
    const upsert = () =>
      store.transition({ key: "shared", kind: "upsert", eventTime: 50, value: "live" });
    const terminal = () =>
      store.transition({ key: "shared", kind: "terminal", eventTime: 50, reason: "closed" });
    await Promise.all(order === "upsert-first" ? [upsert(), terminal()] : [terminal(), upsert()]);
    assert.equal((await store.get("shared"))?.kind, "terminal");
    assert.equal((await store.get("shared"))?.eventTime, 50);
  }
});

test("event permutations converge on the greatest terminal-preferred watermark", async () => {
  const events = [
    { key: "entity", kind: "upsert", eventTime: 2, value: "new" },
    { key: "entity", kind: "terminal", eventTime: 2, reason: "stop" },
    { key: "entity", kind: "upsert", eventTime: 1, value: "old" },
  ];
  for (const ordered of permutations(events)) {
    const { store } = makeStore({ clock: () => 500 });
    for (const event of ordered) await store.transition(event);
    assert.deepEqual(await store.get("entity"), {
      key: "entity",
      kind: "terminal",
      eventTime: 2,
      receivedAt: 500,
      reason: "stop",
    });
  }
});

test("operation IDs replay identical commands and reject identity mismatches", async () => {
  const { store } = makeStore({ clock: () => 100 });
  const input = {
    key: "entity",
    kind: "upsert",
    eventTime: 8,
    receivedAt: 100,
    value: { reading: 1, labels: ["a", "b"] },
    reason: "sample",
    operationId: "operation-8",
  };

  assert.equal((await store.transition(input)).status, "applied");
  assert.deepEqual(
    await store.transition({
      ...input,
      receivedAt: 999,
      value: { labels: ["a", "b"], reading: 1 },
    }),
    {
      status: "replayed",
      accepted: true,
      changed: false,
      previous: { kind: "upsert", eventTime: 8 },
      current: { kind: "upsert", eventTime: 8 },
    },
  );

  for (const conflicting of [
    { ...input, value: { reading: 999, labels: ["a", "b"] } },
    { ...input, reason: "different" },
    {
      key: input.key,
      kind: input.kind,
      eventTime: input.eventTime,
      reason: input.reason,
      operationId: input.operationId,
    },
  ]) {
    await assert.rejects(
      store.transition(conflicting),
      OperationIdConflictError,
    );
  }
  assert.deepEqual((await store.get("entity"))?.value, {
    reading: 1,
    labels: ["a", "b"],
  });
  await assert.rejects(
    store.transition({
      key: "entity",
      kind: "terminal",
      eventTime: 9,
      operationId: "operation-8",
    }),
    OperationIdConflictError,
  );
});

test("memory provider records omit key while store reads restore it", async () => {
  const provider = createMemoryEventWatermarkProvider({
    stateTtlSeconds: 0,
    clock: () => 100,
  });
  const store = createEventWatermarkStore({ provider, clock: () => 100 });
  await store.transition({
    key: "provider-contract",
    kind: "upsert",
    eventTime: 1,
    value: "active",
  });

  assert.deepEqual(await provider.get("provider-contract"), {
    kind: "upsert",
    eventTime: 1,
    receivedAt: 100,
    value: "active",
  });
  assert.deepEqual(await store.get("provider-contract"), {
    key: "provider-contract",
    kind: "upsert",
    eventTime: 1,
    receivedAt: 100,
    value: "active",
  });
});

test("operation payload snapshots cannot drift through caller or read mutations", async () => {
  const { store } = makeStore({
    stateTtlSeconds: 0,
    clock: () => 100,
  });
  const payload = {
    nested: { reading: 1 },
    labels: new Set(["stable"]),
  };
  const input = {
    key: "snapshot",
    kind: "upsert",
    eventTime: 1,
    value: payload,
    operationId: "snapshot-operation",
  };

  assert.equal((await store.transition(input)).status, "applied");
  payload.nested.reading = 2;
  payload.labels.add("mutated");

  const firstRead = await store.get("snapshot");
  assert.equal(firstRead?.kind, "upsert");
  assert.equal(firstRead.value.nested.reading, 1);
  assert.deepEqual([...firstRead.value.labels], ["stable"]);
  firstRead.value.nested.reading = 3;
  firstRead.value.labels.add("read-mutation");

  const secondRead = await store.get("snapshot");
  assert.equal(secondRead?.kind, "upsert");
  assert.equal(secondRead.value.nested.reading, 1);
  assert.deepEqual([...secondRead.value.labels], ["stable"]);
  await assert.rejects(store.transition(input), OperationIdConflictError);
  assert.equal(
    (
      await store.transition({
        ...input,
        receivedAt: 999,
        value: {
          nested: { reading: 1 },
          labels: new Set(["stable"]),
        },
      })
    ).status,
    "replayed",
  );
});

test("provider state survives store facade replacement", async () => {
  const provider = createMemoryEventWatermarkProvider({ clock: () => 100 });
  const first = createEventWatermarkStore({ provider, clock: () => 100 });
  await first.transition({ key: "entity", kind: "terminal", eventTime: 4 });

  const restarted = createEventWatermarkStore({ provider, clock: () => 200 });
  assert.equal(
    (await restarted.transition({ key: "entity", kind: "upsert", eventTime: 4, value: true })).status,
    "blocked-by-terminal",
  );
});

test("state and terminal TTLs expire independently at their exact boundary", async () => {
  let time = 0;
  const { store } = makeStore({
    stateTtlSeconds: 3,
    terminalTtlSeconds: 7,
    clock: () => time,
  });

  await store.transition({ key: "state", kind: "upsert", eventTime: 1, value: true });
  time = 2999;
  assert.notEqual(await store.get("state"), null);
  time = 3000;
  assert.equal(await store.get("state"), null);

  await store.transition({ key: "terminal", kind: "terminal", eventTime: 2 });
  time = 9999;
  assert.notEqual(await store.get("terminal"), null);
  time = 10000;
  assert.equal(await store.get("terminal"), null);
});

test("zero TTL persists and a backwards clock does not shorten or extend elapsed time", async () => {
  let time = 100;
  const { provider, store } = makeStore({
    stateTtlSeconds: 0,
    terminalTtlSeconds: 1,
    clock: () => time,
  });
  await store.transition({ key: "persistent", kind: "upsert", eventTime: 1 });
  await store.transition({ key: "temporary", kind: "terminal", eventTime: 1 });
  time = 50;
  assert.notEqual(await store.get("temporary"), null);
  time = 1100;
  assert.equal(await store.get("temporary"), null);
  assert.notEqual(await store.get("persistent"), null);
  assert.equal(provider.size(), 1);
  provider.clear();
  assert.equal(provider.size(), 0);
});

test("memory provider validates TTL configuration", () => {
  for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, "3"]) {
    assert.throws(
      () => createMemoryEventWatermarkProvider({ stateTtlSeconds: value }),
      /stateTtlSeconds/,
    );
  }
  assert.throws(
    () => createMemoryEventWatermarkProvider({ clock: 1 }),
    /clock/,
  );
});

test("memory provider rejects a non-finite clock result when it is used", async () => {
  const provider = createMemoryEventWatermarkProvider({ clock: () => Number.NaN });
  const store = createEventWatermarkStore({ provider, clock: () => 1 });

  await assert.rejects(
    store.transition({ key: "a", kind: "upsert", eventTime: 1 }),
    /clock result/,
  );
});
