"use strict";

const createCoalescedSnapshotReader = ({ read, ttlMs = 1000, now = Date.now } = {}) => {
  if (typeof read !== "function") throw new TypeError("read must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("ttlMs must be a non-negative finite number");
  }

  let lastTime = Number.NEGATIVE_INFINITY;
  let cached = null;
  let inflight = null;
  let generation = 0;

  const currentTime = () => {
    const value = now();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("now result must be a finite number");
    }
    lastTime = Math.max(lastTime, value);
    return lastTime;
  };

  const reader = async () => {
    const checkedAt = currentTime();
    if (cached && cached.expiresAt > checkedAt) return cached.value;
    if (inflight?.generation === generation) return inflight.promise;

    const startedGeneration = generation;
    let promise;
    const performRead = async () => {
      await undefined;
      try {
        const value = await read();
        if (startedGeneration === generation) {
          cached = Object.freeze({ value, expiresAt: currentTime() + ttlMs });
        }
        return value;
      } finally {
        if (inflight?.promise === promise) inflight = null;
      }
    };
    promise = performRead();
    inflight = { promise, generation: startedGeneration };
    return promise;
  };

  reader.invalidate = () => {
    generation += 1;
    cached = null;
  };

  reader.peek = () => {
    if (!cached || cached.expiresAt <= currentTime()) return null;
    return cached;
  };

  return reader;
};

module.exports = { createCoalescedSnapshotReader };
