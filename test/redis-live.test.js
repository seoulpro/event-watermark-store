import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";

import {
  CorruptStateError,
  OperationIdConflictError,
  createEventWatermarkStore,
} from "../index.js";
import {
  REDIS_TRANSITION_SCRIPT,
  createRedisEventWatermarkProvider,
} from "../redis.js";

const runFile = promisify(execFile);
const enabled = process.env.EVENT_WATERMARK_REDIS_LIVE === "1";
if (enabled) {
  try {
    execFileSync("redis-cli", ["--version"], { stdio: "ignore" });
  } catch (error) {
    throw new Error(
      "EVENT_WATERMARK_REDIS_LIVE=1 requires redis-cli to be available",
      { cause: error },
    );
  }
}

const skipReason = enabled
  ? false
  : "set EVENT_WATERMARK_REDIS_LIVE=1 to run against an explicit local Redis";

test("live Redis executes transition, persistence, restart, and corruption contracts", { skip: skipReason }, async (t) => {
  const host = process.env.EVENT_WATERMARK_REDIS_HOST || "127.0.0.1";
  const port = process.env.EVENT_WATERMARK_REDIS_PORT || "6379";
  const cli = async (...args) => {
    const { stdout } = await runFile(
      "redis-cli",
      ["--json", "-h", host, "-p", port, ...args],
      { encoding: "utf8" },
    );
    return JSON.parse(stdout);
  };
  const execute = ({ script, keys, arguments: scriptArguments }) =>
    cli("EVAL", script, String(keys.length), ...keys, ...scriptArguments);
  const prefix = `event-watermark-test:${randomUUID()}:`;
  const provider = createRedisEventWatermarkProvider({
    execute,
    prefix,
    stateTtlSeconds: 0,
    terminalTtlSeconds: 0,
  });
  const key = "live:{unicode}:상태";
  const redisKey = provider.keyFor(key);
  t.after(() => cli("DEL", redisKey));

  const firstStore = createEventWatermarkStore({ provider });
  assert.equal(
    (
      await firstStore.transition({
        key,
        kind: "upsert",
        eventTime: 10,
        receivedAt: 100,
        value: { reading: 1 },
        reason: "",
        operationId: "live-operation",
      })
    ).status,
    "applied",
  );
  assert.equal(
    (
      await firstStore.transition({
        key,
        kind: "upsert",
        eventTime: 10,
        receivedAt: 999,
        value: { reading: 1 },
        reason: "",
        operationId: "live-operation",
      })
    ).status,
    "replayed",
  );
  await assert.rejects(
    firstStore.transition({
      key,
      kind: "upsert",
      eventTime: 10,
      receivedAt: 1000,
      value: { reading: 2 },
      reason: "",
      operationId: "live-operation",
    }),
    OperationIdConflictError,
  );
  assert.equal((await firstStore.get(key))?.reason, "");
  assert.equal(await cli("TTL", redisKey), -1);
  assert.equal(
    (
      await firstStore.transition({
        key,
        kind: "terminal",
        eventTime: 10,
        receivedAt: 101,
        reason: "ended",
      })
    ).status,
    "applied",
  );

  const restartedStore = createEventWatermarkStore({
    provider: createRedisEventWatermarkProvider({
      execute,
      prefix,
      stateTtlSeconds: 0,
      terminalTtlSeconds: 0,
    }),
  });
  assert.equal(
    (
      await restartedStore.transition({
        key,
        kind: "upsert",
        eventTime: 10,
        receivedAt: 102,
      })
    ).status,
    "blocked-by-terminal",
  );

  await cli("HSET", redisKey, "reason_present", "0");
  await assert.rejects(restartedStore.get(key), CorruptStateError);
  await cli("HSET", redisKey, "reason_present", "1");

  for (const corruptTime of ["nan", "inf", "-inf"]) {
    await cli("HSET", redisKey, "event_time", corruptTime);
    await assert.rejects(
      restartedStore.transition({
        key,
        kind: "upsert",
        eventTime: 11,
        receivedAt: 103,
      }),
      CorruptStateError,
    );
    await assert.rejects(restartedStore.get(key), CorruptStateError);
    assert.equal(await cli("HGET", redisKey, "kind"), "terminal");
    assert.equal(await cli("HGET", redisKey, "event_time"), corruptTime);
  }
  await cli("HSET", redisKey, "event_time", "10", "received_at", "inf");
  await assert.rejects(
    restartedStore.transition({
      key,
      kind: "upsert",
      eventTime: 11,
      receivedAt: 103,
    }),
    CorruptStateError,
  );
  assert.equal(await cli("HGET", redisKey, "kind"), "terminal");
  assert.equal(await cli("HGET", redisKey, "received_at"), "inf");
  await cli("HSET", redisKey, "received_at", "101");

  for (const requestedTime of ["nan", "inf", "-inf"]) {
    await assert.rejects(
      execute({
        script: REDIS_TRANSITION_SCRIPT,
        keys: [redisKey],
        arguments: [
          "upsert",
          requestedTime,
          "104",
          "0",
          "0",
          "0",
          "",
          "",
          "0",
          "",
          "0",
          "",
        ],
      }),
    );
    assert.equal(await cli("HGET", redisKey, "kind"), "terminal");
    assert.equal(await cli("HGET", redisKey, "event_time"), "10");
  }
  await cli("HSET", redisKey, "schema", "invalid");
  await assert.rejects(
    restartedStore.transition({
      key,
      kind: "upsert",
      eventTime: 11,
      receivedAt: 103,
    }),
    CorruptStateError,
  );
});
