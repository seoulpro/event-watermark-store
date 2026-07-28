import assert from "node:assert/strict";
import test from "node:test";

import {
  CorruptStateError,
  OperationIdConflictError,
  ProviderContractError,
  createEventWatermarkStore,
} from "../index.js";
import {
  REDIS_READ_PROTOCOL,
  REDIS_READ_SCRIPT,
  REDIS_SCHEMA_VERSION,
  REDIS_TRANSITION_PROTOCOL,
  REDIS_TRANSITION_SCRIPT,
  createIoRedisExecutor,
  createNodeRedisExecutor,
  createRedisEventWatermarkProvider,
} from "../redis.js";

const queuedExecutor = (...responses) => {
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    if (responses.length === 0) throw new Error("unexpected execution");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, execute };
};

test("Redis protocol constants and scripts are versioned and single-key", () => {
  assert.equal(REDIS_SCHEMA_VERSION, "2");
  assert.equal(REDIS_TRANSITION_PROTOCOL, "event-watermark-store:transition:2");
  assert.equal(REDIS_READ_PROTOCOL, "event-watermark-store:read:2");
  assert.match(REDIS_TRANSITION_SCRIPT, /event-watermark-store:transition:2/);
  assert.match(REDIS_READ_SCRIPT, /event-watermark-store:read:2/);
  assert.match(REDIS_TRANSITION_SCRIPT, /operation_fingerprint/);
  assert.match(REDIS_TRANSITION_SCRIPT, /reason_present/);
  assert.match(REDIS_TRANSITION_SCRIPT, /value ~= value/);
  assert.match(REDIS_TRANSITION_SCRIPT, /math\.huge/);
  assert.match(REDIS_READ_SCRIPT, /value ~= value/);
  assert.match(REDIS_READ_SCRIPT, /math\.huge/);
  assert.match(REDIS_READ_SCRIPT, /unexpected-reason/);
  assert.match(REDIS_TRANSITION_SCRIPT, /PERSIST/);
  assert.match(REDIS_TRANSITION_SCRIPT, /EXPIRE/);
  assert.doesNotMatch(REDIS_TRANSITION_SCRIPT, /KEYS\[2\]/);
  assert.doesNotMatch(REDIS_READ_SCRIPT, /KEYS\[2\]/);
});

test("Redis provider constructs canonical cluster-safe keys for arbitrary identifiers", () => {
  const provider = createRedisEventWatermarkProvider({ execute: async () => [] });
  const first = provider.keyFor("tenant:{west}:장치/α");
  const again = provider.keyFor("tenant:{west}:장치/α");
  const other = provider.keyFor("tenant:{west}:장치/β");

  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.equal(first.includes("tenant:{west}"), false);
  assert.match(first, /^event-watermark:\{[A-Za-z0-9_-]+\}:record$/);
  assert.equal((first.match(/\{/g) ?? []).length, 1);
  assert.equal((first.match(/\}/g) ?? []).length, 1);
  assert.throws(() => provider.keyFor(""), /non-empty string/);
  assert.throws(() => provider.keyFor(1), /non-empty string/);
  assert.throws(() => provider.keyFor("\ud800"), /well-formed Unicode/);
  assert.throws(() => provider.keyFor("\udc00"), /well-formed Unicode/);
  assert.match(
    provider.keyFor("\ufffd"),
    /^event-watermark:\{[A-Za-z0-9_-]+\}:record$/,
  );
  assert.notEqual(provider.keyFor("\ufffd"), provider.keyFor("\ud83d\ude00"));
});

test("Redis transition request carries explicit TTL, presence, and codec fields", async () => {
  const recording = queuedExecutor([
    REDIS_TRANSITION_PROTOCOL,
    "applied",
    "",
    "",
    "upsert",
    "12",
  ]);
  const provider = createRedisEventWatermarkProvider({
    execute: recording.execute,
    prefix: "test:",
    stateTtlSeconds: 300,
    terminalTtlSeconds: 604800,
    encode: (value) => `encoded:${value.reading}`,
    decode: () => {
      throw new Error("not used");
    },
  });
  const store = createEventWatermarkStore({ provider, clock: () => 90 });

  assert.equal(
    (
      await store.transition({
        key: "device",
        kind: "upsert",
        eventTime: 12,
        value: { reading: 7 },
        reason: "sample",
        operationId: "op-12",
      })
    ).status,
    "applied",
  );
  const request = recording.calls[0];
  assert.equal(request.script, REDIS_TRANSITION_SCRIPT);
  assert.deepEqual(request.keys, ["test:{ZGV2aWNl}:record"]);
  assert.deepEqual(request.arguments.slice(0, 7), [
    "upsert",
    "12",
    "90",
    "300",
    "604800",
    "1",
    "op-12",
  ]);
  assert.match(request.arguments[7], /^[0-9a-f]{64}$/);
  assert.deepEqual(request.arguments.slice(8), [
    "1",
    "encoded:7",
    "1",
    "sample",
  ]);
});

test("Redis script requests fingerprint payload identity but not received time", async () => {
  let current = null;
  const requests = [];
  const execute = async (request) => {
    requests.push(request);
    const [kind, eventTime, , , , operationPresent, operationId, fingerprint] =
      request.arguments;
    assert.equal(operationPresent, "1");
    if (current?.operationId === operationId) {
      if (current.fingerprint !== fingerprint) {
        return [
          REDIS_TRANSITION_PROTOCOL,
          "operation-conflict",
          current.kind,
          current.eventTime,
          current.kind,
          current.eventTime,
        ];
      }
      return [
        REDIS_TRANSITION_PROTOCOL,
        "replayed",
        current.kind,
        current.eventTime,
        current.kind,
        current.eventTime,
      ];
    }
    current = { kind, eventTime, operationId, fingerprint };
    return [REDIS_TRANSITION_PROTOCOL, "applied", "", "", kind, eventTime];
  };
  const store = createEventWatermarkStore({
    provider: createRedisEventWatermarkProvider({ execute }),
  });
  const input = {
    key: "identity",
    kind: "upsert",
    eventTime: 5,
    receivedAt: 10,
    value: { reading: 1, metadata: { b: 2, a: 1 } },
    reason: "sample",
    operationId: "operation-5",
  };

  assert.equal((await store.transition(input)).status, "applied");
  assert.equal(
    (
      await store.transition({
        ...input,
        receivedAt: 999,
        value: { metadata: { a: 1, b: 2 }, reading: 1 },
      })
    ).status,
    "replayed",
  );
  await assert.rejects(
    store.transition({ ...input, value: { reading: 2 } }),
    OperationIdConflictError,
  );
  await assert.rejects(
    store.transition({ ...input, reason: "different" }),
    OperationIdConflictError,
  );
  assert.equal(requests[0].arguments[7], requests[1].arguments[7]);
  assert.equal(requests[0].arguments[9], requests[1].arguments[9]);
  assert.equal(
    requests[0].arguments[9],
    '{"metadata":{"a":1,"b":2},"reading":1}',
  );
  assert.notEqual(requests[0].arguments[7], requests[2].arguments[7]);
  assert.notEqual(requests[0].arguments[7], requests[3].arguments[7]);
});

test("Redis provider maps every transition outcome without ambiguous flags", async () => {
  const cases = [
    {
      response: [REDIS_TRANSITION_PROTOCOL, "applied", "", "", "upsert", "10"],
      input: { key: "a", kind: "upsert", eventTime: 10, receivedAt: 20 },
      expected: ["applied", true, true],
    },
    {
      response: [REDIS_TRANSITION_PROTOCOL, "refreshed", "upsert", "10", "upsert", "10"],
      input: { key: "a", kind: "upsert", eventTime: 10, receivedAt: 21 },
      expected: ["refreshed", true, true],
    },
    {
      response: [REDIS_TRANSITION_PROTOCOL, "replayed", "upsert", "10", "upsert", "10"],
      input: { key: "a", kind: "upsert", eventTime: 10, receivedAt: 22, operationId: "op" },
      expected: ["replayed", true, false],
    },
    {
      response: [REDIS_TRANSITION_PROTOCOL, "stale", "upsert", "10", "upsert", "10"],
      input: { key: "a", kind: "upsert", eventTime: 9, receivedAt: 23 },
      expected: ["stale", false, false],
    },
    {
      response: [
        REDIS_TRANSITION_PROTOCOL,
        "blocked-by-terminal",
        "terminal",
        "10",
        "terminal",
        "10",
      ],
      input: { key: "a", kind: "upsert", eventTime: 10, receivedAt: 24 },
      expected: ["blocked-by-terminal", false, false],
    },
  ];

  for (const { response, input, expected } of cases) {
    const provider = createRedisEventWatermarkProvider({
      execute: queuedExecutor(response).execute,
    });
    const result = await createEventWatermarkStore({ provider }).transition(input);
    assert.deepEqual([result.status, result.accepted, result.changed], expected);
  }
});

test("Redis provider maps reads and decodes only present upsert values", async () => {
  const recording = queuedExecutor(
    [
      REDIS_READ_PROTOCOL,
      "ok",
      "upsert",
      "15",
      "25",
      "1",
      "op-15",
      "1",
      "payload:8",
      "1",
      "sample",
    ],
    [REDIS_READ_PROTOCOL, "ok", "terminal", "16", "26", "0", "", "0", "", "1", "closed"],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "17", "27", "0", "", "0", "", "1", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "18", "28", "0", "", "0", "", "0", ""],
    [REDIS_READ_PROTOCOL, "missing"],
  );
  const provider = createRedisEventWatermarkProvider({
    execute: recording.execute,
    decode: (encoded) => ({ reading: Number(encoded.split(":")[1]) }),
  });
  const store = createEventWatermarkStore({ provider });
  await assert.rejects(
    provider.transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      valuePresent: false,
      value: undefined,
      reason: undefined,
      operationId: 3,
    }),
    /operationId must be a string/,
  );

  assert.deepEqual(await store.get("a"), {
    key: "a",
    kind: "upsert",
    eventTime: 15,
    receivedAt: 25,
    operationId: "op-15",
    value: { reading: 8 },
    reason: "sample",
  });
  assert.deepEqual(await store.get("a"), {
    key: "a",
    kind: "terminal",
    eventTime: 16,
    receivedAt: 26,
    reason: "closed",
  });
  assert.deepEqual(await store.get("a"), {
    key: "a",
    kind: "upsert",
    eventTime: 17,
    receivedAt: 27,
    reason: "",
  });
  assert.deepEqual(await store.get("a"), {
    key: "a",
    kind: "upsert",
    eventTime: 18,
    receivedAt: 28,
  });
  assert.equal(await store.get("a"), null);
  assert.equal(recording.calls.every((call) => call.script === REDIS_READ_SCRIPT), true);
});

test("Redis corrupt state and operation conflicts fail closed", async () => {
  const corruptProvider = createRedisEventWatermarkProvider({
    execute: queuedExecutor([REDIS_TRANSITION_PROTOCOL, "corrupt", "schema", "", "", ""]).execute,
  });
  await assert.rejects(
    createEventWatermarkStore({ provider: corruptProvider }).transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
    }),
    (error) => error instanceof CorruptStateError && error.detail === "schema",
  );

  const readCorrupt = createRedisEventWatermarkProvider({
    execute: queuedExecutor([REDIS_READ_PROTOCOL, "corrupt", "wrong-type"]).execute,
  });
  await assert.rejects(
    createEventWatermarkStore({ provider: readCorrupt }).get("a"),
    CorruptStateError,
  );

  const conflictProvider = createRedisEventWatermarkProvider({
    execute: queuedExecutor([
      REDIS_TRANSITION_PROTOCOL,
      "operation-conflict",
      "upsert",
      "1",
      "upsert",
      "1",
    ]).execute,
  });
  await assert.rejects(
    createEventWatermarkStore({ provider: conflictProvider }).transition({
      key: "a",
      kind: "upsert",
      eventTime: 2,
      receivedAt: 3,
      operationId: "reused",
    }),
    OperationIdConflictError,
  );
});

test("Redis replies are validated before entering the public store", async () => {
  for (const response of [
    null,
    ["wrong-version", "applied", "", "", "upsert", "1"],
    [REDIS_TRANSITION_PROTOCOL, "unknown", "", "", "upsert", "1"],
    [REDIS_TRANSITION_PROTOCOL, "applied", "", "", "", ""],
  ]) {
    const provider = createRedisEventWatermarkProvider({
      execute: queuedExecutor(response).execute,
    });
    await assert.rejects(
      createEventWatermarkStore({ provider }).transition({
        key: "a",
        kind: "upsert",
        eventTime: 1,
        receivedAt: 2,
      }),
      ProviderContractError,
    );
  }
});

test("Redis reads reject malformed protocol fields and accept binary replies", async () => {
  const binaryProvider = createRedisEventWatermarkProvider({
    execute: queuedExecutor([
      Buffer.from(REDIS_READ_PROTOCOL),
      Buffer.from("ok"),
      Buffer.from("upsert"),
      Buffer.from("1"),
      new Uint8Array(Buffer.from("2")),
      Buffer.from("0"),
      Buffer.from(""),
      Buffer.from("0"),
      Buffer.from(""),
      Buffer.from("0"),
      Buffer.from(""),
    ]).execute,
  });
  assert.deepEqual(await binaryProvider.get("a"), {
    kind: "upsert",
    eventTime: 1,
    receivedAt: 2,
  });

  const malformed = [
    ["wrong-version", "ok", "upsert", "1", "2", "0", "", "0", "", "0", ""],
    [REDIS_READ_PROTOCOL, "ok", "other", "1", "2", "0", "", "0", "", "0", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "1", "2", "x", "", "0", "", "0", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "1", "2", "0", "unexpected", "0", "", "0", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "1", "2", "0", "", "x", "", "0", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "1", "2", "0", "", "0", "unexpected", "0", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "1", "2", "0", "", "0", "", "x", ""],
    [REDIS_READ_PROTOCOL, "ok", "upsert", "1", "2", "0", "", "0", "", "0", "unexpected"],
  ];
  for (const response of malformed) {
    const provider = createRedisEventWatermarkProvider({
      execute: queuedExecutor(response).execute,
    });
    await assert.rejects(provider.get("a"), ProviderContractError);
  }
});

test("codec errors happen before Redis execution", async () => {
  let calls = 0;
  const provider = createRedisEventWatermarkProvider({
    execute() {
      calls += 1;
    },
  });
  const store = createEventWatermarkStore({ provider });
  await assert.rejects(
    provider.transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      valuePresent: false,
      value: undefined,
      reason: undefined,
      operationId: "\ud800",
    }),
    /well-formed Unicode/,
  );
  await assert.rejects(
    provider.transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      valuePresent: false,
      value: undefined,
      reason: "\udc00",
      operationId: undefined,
    }),
    /well-formed Unicode/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    store.transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      value: cyclic,
    }),
    TypeError,
  );
  await assert.rejects(
    store.transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      value: undefined,
    }),
    /JSON-encodable/,
  );

  const nonStringCodec = createRedisEventWatermarkProvider({
    execute() {
      calls += 1;
    },
    encode() {
      return 7;
    },
  });
  await assert.rejects(
    createEventWatermarkStore({ provider: nonStringCodec }).transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      value: "present",
    }),
    /encode must return a string/,
  );

  const malformedUnicodeCodec = createRedisEventWatermarkProvider({
    execute() {
      calls += 1;
    },
    encode() {
      return "\ud800";
    },
  });
  await assert.rejects(
    createEventWatermarkStore({ provider: malformedUnicodeCodec }).transition({
      key: "a",
      kind: "upsert",
      eventTime: 1,
      receivedAt: 2,
      value: "present",
      operationId: "codec-operation",
    }),
    /well-formed Unicode/,
  );
  assert.equal(calls, 0);
});

test("ioredis and node-redis helpers adapt only their documented eval shapes", async () => {
  const ioCalls = [];
  const ioExecute = createIoRedisExecutor({
    eval(...args) {
      ioCalls.push(args);
      return ["io"];
    },
  });
  assert.deepEqual(
    await ioExecute({ script: "return 1", keys: ["k1", "k2"], arguments: ["a"] }),
    ["io"],
  );
  assert.deepEqual(ioCalls[0], ["return 1", 2, "k1", "k2", "a"]);

  const nodeCalls = [];
  const nodeExecute = createNodeRedisExecutor({
    eval(...args) {
      nodeCalls.push(args);
      return ["node"];
    },
  });
  assert.deepEqual(
    await nodeExecute({ script: "return 1", keys: ["k"], arguments: ["a", "b"] }),
    ["node"],
  );
  assert.deepEqual(nodeCalls[0], [
    "return 1",
    { keys: ["k"], arguments: ["a", "b"] },
  ]);
});

test("Redis configuration rejects unsafe prefixes and invalid TTLs", () => {
  for (const prefix of ["bad{prefix", "bad}prefix"]) {
    assert.throws(
      () => createRedisEventWatermarkProvider({ execute() {}, prefix }),
      /hash-tag braces/,
    );
  }
  assert.throws(
    () => createRedisEventWatermarkProvider({ execute() {}, prefix: "\ud800" }),
    /well-formed Unicode/,
  );
  for (const stateTtlSeconds of [-1, 1.5, "3"]) {
    assert.throws(
      () => createRedisEventWatermarkProvider({ execute() {}, stateTtlSeconds }),
      /stateTtlSeconds/,
    );
  }
  assert.throws(() => createRedisEventWatermarkProvider(), /execute/);
  assert.throws(() => createIoRedisExecutor({}), /client.eval/);
  assert.throws(() => createNodeRedisExecutor({}), /client.eval/);
});
