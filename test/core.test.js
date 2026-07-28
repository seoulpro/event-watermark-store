import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderContractError,
  TRANSITION_STATUSES,
  createEventWatermarkStore,
  decideTransition,
} from "../index.js";

test("decision table preserves terminal precedence at equal event time", () => {
  const cases = [
    [null, { kind: "upsert", eventTime: 10 }, "applied"],
    [null, { kind: "terminal", eventTime: 10 }, "applied"],
    [{ kind: "upsert", eventTime: 10 }, { kind: "upsert", eventTime: 9 }, "stale"],
    [{ kind: "upsert", eventTime: 10 }, { kind: "terminal", eventTime: 9 }, "stale"],
    [{ kind: "upsert", eventTime: 10 }, { kind: "upsert", eventTime: 10 }, "refreshed"],
    [{ kind: "upsert", eventTime: 10 }, { kind: "terminal", eventTime: 10 }, "applied"],
    [{ kind: "terminal", eventTime: 10 }, { kind: "upsert", eventTime: 9 }, "blocked-by-terminal"],
    [{ kind: "terminal", eventTime: 10 }, { kind: "terminal", eventTime: 9 }, "blocked-by-terminal"],
    [{ kind: "terminal", eventTime: 10 }, { kind: "upsert", eventTime: 10 }, "blocked-by-terminal"],
    [{ kind: "terminal", eventTime: 10 }, { kind: "terminal", eventTime: 10 }, "blocked-by-terminal"],
    [{ kind: "terminal", eventTime: 10 }, { kind: "upsert", eventTime: 11 }, "applied"],
    [{ kind: "terminal", eventTime: 10 }, { kind: "terminal", eventTime: 11 }, "applied"],
  ];

  for (const [current, incoming, expected] of cases) {
    assert.equal(decideTransition({ current, incoming }), expected);
  }
});

test("decision inputs are strict and do not coerce time values", () => {
  for (const eventTime of [null, "", "10", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => decideTransition({ incoming: { kind: "upsert", eventTime } }),
      /finite number/,
    );
  }
  assert.throws(() => decideTransition(), /incoming/);
  assert.throws(
    () => decideTransition({ incoming: { kind: "other", eventTime: 1 } }),
    /upsert.*terminal/,
  );
});

test("store normalizes commands and supplies its clock", async () => {
  const seen = [];
  const provider = {
    transition(command) {
      seen.push(command);
      return {
        status: "applied",
        accepted: true,
        changed: true,
        previous: null,
        current: { kind: command.kind, eventTime: command.eventTime },
      };
    },
    get() {
      return {
        kind: "upsert",
        eventTime: 12,
        receivedAt: 30,
        value: { online: true },
      };
    },
  };
  const store = createEventWatermarkStore({ provider, clock: () => 30 });

  assert.deepEqual(
    await store.transition({
      key: "device-a",
      kind: "upsert",
      eventTime: 12,
      value: { online: true },
      operationId: "op-12",
    }),
    {
      status: "applied",
      accepted: true,
      changed: true,
      previous: null,
      current: { kind: "upsert", eventTime: 12 },
    },
  );
  assert.deepEqual(seen[0], {
    key: "device-a",
    kind: "upsert",
    eventTime: 12,
    receivedAt: 30,
    valuePresent: true,
    value: { online: true },
    reason: undefined,
    operationId: "op-12",
  });
  assert.deepEqual(await store.get("device-a"), {
    key: "device-a",
    kind: "upsert",
    eventTime: 12,
    receivedAt: 30,
    value: { online: true },
  });
});

test("store rejects ambiguous or malformed commands before reaching the provider", async () => {
  let calls = 0;
  const store = createEventWatermarkStore({
    provider: {
      transition() {
        calls += 1;
        throw new Error("not reached");
      },
    },
  });

  const invalid = [
    null,
    {},
    { key: "", kind: "upsert", eventTime: 1 },
    { key: "\ud800", kind: "upsert", eventTime: 1 },
    { key: "\udc00", kind: "upsert", eventTime: 1 },
    { key: "a", kind: "unknown", eventTime: 1 },
    { key: "a", kind: "upsert", eventTime: "1" },
    { key: "a", kind: "upsert", eventTime: Number.NaN },
    { key: "a", kind: "upsert", eventTime: 1, receivedAt: "" },
    { key: "a", kind: "upsert", eventTime: 1, reason: 3 },
    { key: "a", kind: "upsert", eventTime: 1, reason: "\ud800" },
    { key: "a", kind: "upsert", eventTime: 1, operationId: "" },
    { key: "a", kind: "upsert", eventTime: 1, operationId: 3 },
    { key: "a", kind: "upsert", eventTime: 1, operationId: "\udc00" },
    { key: "a", kind: "terminal", eventTime: 1, value: null },
  ];
  for (const input of invalid) await assert.rejects(store.transition(input), TypeError);
  assert.equal(calls, 0);
});

test("store accepts replacement characters but rejects lone UTF-16 surrogates", async () => {
  const seen = [];
  const store = createEventWatermarkStore({
    provider: {
      transition(command) {
        seen.push(command.key);
        return {
          status: "applied",
          accepted: true,
          changed: true,
          previous: null,
          current: { kind: command.kind, eventTime: command.eventTime },
        };
      },
      get() {
        return null;
      },
    },
  });

  for (const key of ["\ufffd", "paired-\ud83d\ude00"]) {
    assert.equal(
      (
        await store.transition({
          key,
          kind: "upsert",
          eventTime: 1,
          reason: "\ufffd",
          operationId: `operation-${key}`,
        })
      ).status,
      "applied",
    );
  }
  assert.deepEqual(seen, ["\ufffd", "paired-\ud83d\ude00"]);
  for (const key of ["\ud800", "\udc00"]) {
    await assert.rejects(store.get(key), /well-formed Unicode/);
  }
});

test("store enforces the atomic provider result contract", async () => {
  for (const result of [
    null,
    {
      status: "unknown",
      accepted: false,
      changed: false,
      previous: null,
      current: { kind: "upsert", eventTime: 1 },
    },
    {
      status: "applied",
      accepted: false,
      changed: true,
      previous: null,
      current: { kind: "upsert", eventTime: 1 },
    },
    {
      status: "stale",
      accepted: false,
      changed: false,
      previous: null,
      current: { kind: "upsert", eventTime: 1 },
    },
    {
      status: "applied",
      accepted: true,
      changed: true,
      previous: null,
      current: null,
    },
    {
      status: "applied",
      accepted: true,
      changed: true,
      previous: null,
      current: { kind: "upsert", eventTime: 2 },
    },
  ]) {
    const store = createEventWatermarkStore({ provider: { transition: () => result } });
    await assert.rejects(
      store.transition({ key: "a", kind: "upsert", eventTime: 1, receivedAt: 2 }),
      ProviderContractError,
    );
  }
});

test("store validates provider capabilities and stored records", async () => {
  assert.throws(() => createEventWatermarkStore(), /provider\.transition/);
  assert.throws(
    () =>
      createEventWatermarkStore({
        provider: { transition() {} },
        clock: 1,
      }),
    /clock/,
  );

  const transitionOnly = createEventWatermarkStore({
    provider: { transition() {} },
  });
  await assert.rejects(transitionOnly.get("a"), ProviderContractError);

  const malformedRead = createEventWatermarkStore({
    provider: {
      transition() {},
      get() {
        return {
          kind: "terminal",
          eventTime: 1,
          receivedAt: 2,
          value: "not allowed",
        };
      },
    },
  });
  await assert.rejects(malformedRead.get("a"), ProviderContractError);
});

test("store rejects provider statuses that violate the ordering policy", async () => {
  const cases = [
    {
      input: { key: "a", kind: "upsert", eventTime: 1, receivedAt: 2 },
      result: {
        status: "replayed",
        accepted: true,
        changed: false,
        previous: { kind: "upsert", eventTime: 1 },
        current: { kind: "upsert", eventTime: 1 },
      },
    },
    {
      input: { key: "a", kind: "upsert", eventTime: 11, receivedAt: 2 },
      result: {
        status: "stale",
        accepted: false,
        changed: false,
        previous: { kind: "upsert", eventTime: 10 },
        current: { kind: "upsert", eventTime: 10 },
      },
    },
    {
      input: { key: "a", kind: "upsert", eventTime: 9, receivedAt: 2 },
      result: {
        status: "blocked-by-terminal",
        accepted: false,
        changed: false,
        previous: { kind: "upsert", eventTime: 10 },
        current: { kind: "upsert", eventTime: 10 },
      },
    },
    {
      input: { key: "a", kind: "upsert", eventTime: 10, receivedAt: 2 },
      result: {
        status: "applied",
        accepted: true,
        changed: true,
        previous: { kind: "terminal", eventTime: 10 },
        current: { kind: "upsert", eventTime: 10 },
      },
    },
  ];

  for (const { input, result } of cases) {
    const store = createEventWatermarkStore({
      provider: { transition: () => result },
    });
    await assert.rejects(
      store.transition(input),
      ProviderContractError,
    );
  }
});

test("public status list is stable and complete", () => {
  assert.deepEqual([...TRANSITION_STATUSES], [
    "applied",
    "refreshed",
    "replayed",
    "stale",
    "blocked-by-terminal",
  ]);
  assert.equal(Object.isFrozen(TRANSITION_STATUSES), true);
});
