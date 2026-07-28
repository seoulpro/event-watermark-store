import assert from "node:assert/strict";
import test from "node:test";

import { createCoalescedSnapshotReader } from "../cache.js";

test("coalesces concurrent reads and starts TTL when the read completes", async () => {
  let time = 100;
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reader = createCoalescedSnapshotReader({
    ttlMs: 10,
    now: () => time,
    read: async () => {
      reads += 1;
      await gate;
      return { version: reads };
    },
  });

  const first = reader();
  const second = reader();
  time = 105;
  release();
  assert.strictEqual(await first, await second);
  assert.equal(reads, 1);
  time = 114;
  assert.deepEqual(await reader(), { version: 1 });
  time = 115;
  assert.deepEqual(await reader(), { version: 2 });
});

test("failed reads are not cached and can be retried", async () => {
  let reads = 0;
  const reader = createCoalescedSnapshotReader({
    read() {
      reads += 1;
      if (reads === 1) throw new Error("temporary");
      return reads;
    },
  });
  await assert.rejects(reader(), /temporary/);
  assert.equal(await reader(), 2);
  assert.equal(reads, 2);
});

test("invalidate starts a fresh generation without waiting for an older read", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reader = createCoalescedSnapshotReader({
    read: async () => {
      const version = ++reads;
      if (version === 1) await gate;
      return version;
    },
  });

  const oldRead = reader();
  reader.invalidate();
  const freshRead = reader();
  assert.equal(await freshRead, 2);
  release();
  assert.equal(await oldRead, 1);
  assert.equal(reader.peek()?.value, 2);
  assert.equal(await reader(), 2);
  assert.equal(reads, 2);
});

test("clock rollback is clamped and peek expires at the exact TTL boundary", async () => {
  let time = 100;
  const reader = createCoalescedSnapshotReader({
    ttlMs: 10,
    now: () => time,
    read: () => "snapshot",
  });
  await reader();
  time = 90;
  assert.deepEqual(reader.peek(), { value: "snapshot", expiresAt: 110 });
  time = 110;
  assert.equal(reader.peek(), null);
});

test("zero TTL only coalesces inflight work", async () => {
  let reads = 0;
  const reader = createCoalescedSnapshotReader({ ttlMs: 0, read: () => ++reads });
  assert.equal(await reader(), 1);
  assert.equal(await reader(), 2);
});

test("cache options and clock values are validated strictly", async () => {
  assert.throws(() => createCoalescedSnapshotReader(), /read/);
  for (const ttlMs of [-1, "1", Number.NaN]) {
    assert.throws(() => createCoalescedSnapshotReader({ read() {}, ttlMs }), /ttlMs/);
  }
  const reader = createCoalescedSnapshotReader({ read() {}, now: () => Number.NaN });
  await assert.rejects(reader(), /finite number/);
});
