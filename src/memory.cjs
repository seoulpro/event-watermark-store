"use strict";

const {
  CorruptStateError,
  OperationIdConflictError,
  decideTransition,
} = require("./core.cjs");
const {
  canonicalEncodeValue,
  cloneCanonicalValue,
  createOperationFingerprint,
} = require("./fingerprint.cjs");

const normalizeTtlSeconds = (value, label) => {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const createMonotonicClock = (clock) => {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const value = clock();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("clock result must be a finite number");
    }
    last = Math.max(last, value);
    return last;
  };
};

const watermarkOf = (record) =>
  record ? Object.freeze({ kind: record.kind, eventTime: record.eventTime }) : null;

const publicRecordOf = (record) => {
  if (!record) return null;
  const output = {
    kind: record.kind,
    eventTime: record.eventTime,
    receivedAt: record.receivedAt,
  };
  if (record.operationId !== undefined) output.operationId = record.operationId;
  if (record.reason !== undefined) output.reason = record.reason;
  if (record.valuePresent) {
    output.value =
      record.operationId === undefined
        ? record.value
        : cloneCanonicalValue(record.value);
  }
  return Object.freeze(output);
};

const createMemoryEventWatermarkProvider = ({
  stateTtlSeconds = 300,
  terminalTtlSeconds = 7 * 24 * 60 * 60,
  clock = Date.now,
} = {}) => {
  const stateTtl = normalizeTtlSeconds(stateTtlSeconds, "stateTtlSeconds");
  const terminalTtl = normalizeTtlSeconds(terminalTtlSeconds, "terminalTtlSeconds");
  const now = createMonotonicClock(clock);
  const records = new Map();

  const currentRecord = (key) => {
    const record = records.get(key);
    if (!record) return null;
    if (record.expiresAt !== Number.POSITIVE_INFINITY && record.expiresAt <= now()) {
      records.delete(key);
      return null;
    }
    if (
      (record.kind !== "upsert" && record.kind !== "terminal") ||
      typeof record.eventTime !== "number" ||
      !Number.isFinite(record.eventTime) ||
      (record.operationId === undefined) !== (record.operationFingerprint === undefined) ||
      (record.operationFingerprint !== undefined &&
        !/^[0-9a-f]{64}$/.test(record.operationFingerprint))
    ) {
      throw new CorruptStateError(key);
    }
    return record;
  };

  const transition = async (command) => {
    const beforeRecord = currentRecord(command.key);
    const previous = watermarkOf(beforeRecord);
    const operationValue =
      command.operationId !== undefined && command.valuePresent
        ? cloneCanonicalValue(command.value)
        : command.value;
    const operationFingerprint =
      command.operationId === undefined
        ? undefined
        : createOperationFingerprint(
            command,
            command.valuePresent ? canonicalEncodeValue(operationValue) : "",
          );

    if (beforeRecord?.operationId !== undefined && beforeRecord.operationId === command.operationId) {
      if (beforeRecord.operationFingerprint !== operationFingerprint) {
        throw new OperationIdConflictError(command.key, command.operationId);
      }
      return Object.freeze({
        status: "replayed",
        accepted: true,
        changed: false,
        previous,
        current: previous,
      });
    }

    const status = decideTransition({
      current: previous,
      incoming: { kind: command.kind, eventTime: command.eventTime },
    });

    if (status === "stale" || status === "blocked-by-terminal") {
      return Object.freeze({
        status,
        accepted: false,
        changed: false,
        previous,
        current: previous,
      });
    }

    const ttl = command.kind === "terminal" ? terminalTtl : stateTtl;
    const record = {
      kind: command.kind,
      eventTime: command.eventTime,
      receivedAt: command.receivedAt,
      operationId: command.operationId,
      operationFingerprint,
      reason: command.reason,
      valuePresent: command.kind === "upsert" && command.valuePresent,
      value: operationValue,
      expiresAt: ttl === 0 ? Number.POSITIVE_INFINITY : now() + ttl * 1000,
    };
    records.set(command.key, record);

    return Object.freeze({
      status,
      accepted: true,
      changed: true,
      previous,
      current: watermarkOf(record),
    });
  };

  const get = async (key) => publicRecordOf(currentRecord(key));

  const clear = () => records.clear();

  const size = () => {
    for (const key of records.keys()) currentRecord(key);
    return records.size;
  };

  return Object.freeze({ transition, get, clear, size });
};

module.exports = { createMemoryEventWatermarkProvider };
