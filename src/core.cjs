"use strict";

const {
  requireKey,
  requireWellFormedUnicode,
} = require("./key.cjs");

const POLICY_VERSION = 1;

const TRANSITION_STATUSES = Object.freeze([
  "applied",
  "refreshed",
  "replayed",
  "stale",
  "blocked-by-terminal",
]);

const STATUS_FLAGS = Object.freeze({
  applied: Object.freeze({ accepted: true, changed: true }),
  refreshed: Object.freeze({ accepted: true, changed: true }),
  replayed: Object.freeze({ accepted: true, changed: false }),
  stale: Object.freeze({ accepted: false, changed: false }),
  "blocked-by-terminal": Object.freeze({ accepted: false, changed: false }),
});

class EventWatermarkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

class ProviderContractError extends EventWatermarkError {}

class CorruptStateError extends EventWatermarkError {
  constructor(key, detail = "stored watermark state is invalid") {
    super(`Corrupt state for ${JSON.stringify(key)}: ${detail}`);
    this.key = key;
    this.detail = detail;
  }
}

class OperationIdConflictError extends EventWatermarkError {
  constructor(key, operationId) {
    super(`Operation ID ${JSON.stringify(operationId)} conflicts for ${JSON.stringify(key)}`);
    this.key = key;
    this.operationId = operationId;
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const requireKind = (value, label = "kind") => {
  if (value !== "upsert" && value !== "terminal") {
    throw new TypeError(`${label} must be "upsert" or "terminal"`);
  }
  return value;
};

const requireFiniteNumber = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
};

const normalizeWatermark = (value, label) => {
  if (value === null) return null;
  const input = requireObject(value, label);
  return Object.freeze({
    kind: requireKind(input.kind, `${label}.kind`),
    eventTime: requireFiniteNumber(input.eventTime, `${label}.eventTime`),
  });
};

const sameWatermark = (left, right) =>
  left !== null &&
  right !== null &&
  left.kind === right.kind &&
  left.eventTime === right.eventTime;

const decideTransition = ({ current = null, incoming } = {}) => {
  const previous = normalizeWatermark(current, "current");
  const next = normalizeWatermark(incoming, "incoming");
  if (next === null) throw new TypeError("incoming must be a watermark");

  if (previous === null) return "applied";
  if (previous.kind === "terminal" && next.eventTime <= previous.eventTime) {
    return "blocked-by-terminal";
  }
  if (next.eventTime < previous.eventTime) return "stale";
  if (
    next.eventTime === previous.eventTime &&
    previous.kind === "upsert" &&
    next.kind === "upsert"
  ) {
    return "refreshed";
  }
  return "applied";
};

const normalizeTransition = (input, clock) => {
  const candidate = requireObject(input, "transition");
  const key = requireKey(candidate.key);
  const kind = requireKind(candidate.kind);
  const eventTime = requireFiniteNumber(candidate.eventTime, "eventTime");

  let receivedAt;
  if (hasOwn(candidate, "receivedAt") && candidate.receivedAt !== undefined) {
    receivedAt = requireFiniteNumber(candidate.receivedAt, "receivedAt");
  } else {
    receivedAt = requireFiniteNumber(clock(), "clock result");
  }

  const valuePresent = hasOwn(candidate, "value");
  if (kind === "terminal" && valuePresent) {
    throw new TypeError("terminal transitions cannot carry a value");
  }

  let reason;
  if (hasOwn(candidate, "reason") && candidate.reason !== undefined) {
    if (typeof candidate.reason !== "string") {
      throw new TypeError("reason must be a string when provided");
    }
    reason = requireWellFormedUnicode(candidate.reason, "reason");
  }

  let operationId;
  if (hasOwn(candidate, "operationId") && candidate.operationId !== undefined) {
    if (typeof candidate.operationId !== "string" || candidate.operationId.length === 0) {
      throw new TypeError("operationId must be a non-empty string when provided");
    }
    operationId = requireWellFormedUnicode(candidate.operationId, "operationId");
  }

  return Object.freeze({
    key,
    kind,
    eventTime,
    receivedAt,
    valuePresent,
    value: candidate.value,
    reason,
    operationId,
  });
};

const normalizeResult = (result, command) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ProviderContractError("Provider transition result must be an object");
  }
  const output = result;
  const flags = STATUS_FLAGS[output.status];
  if (!flags) {
    throw new ProviderContractError(`Unknown provider transition status: ${String(output.status)}`);
  }
  if (output.accepted !== flags.accepted || output.changed !== flags.changed) {
    throw new ProviderContractError(`Inconsistent flags for transition status ${output.status}`);
  }

  const previous = normalizeWatermark(output.previous ?? null, "result.previous");
  const current = normalizeWatermark(output.current, "result.current");
  if (current === null) {
    throw new ProviderContractError("Provider transition result must include current watermark");
  }

  if (flags.accepted) {
    const expected = Object.freeze({ kind: command.kind, eventTime: command.eventTime });
    if (!sameWatermark(current, expected)) {
      throw new ProviderContractError("Accepted transition did not produce the requested watermark");
    }
  }

  if (output.status === "replayed") {
    if (command.operationId === undefined) {
      throw new ProviderContractError("A replayed result requires an operationId");
    }
  } else {
    const expectedStatus = decideTransition({
      current: previous,
      incoming: { kind: command.kind, eventTime: command.eventTime },
    });
    if (output.status !== expectedStatus) {
      throw new ProviderContractError(
        `Provider status ${output.status} violates ordering policy; expected ${expectedStatus}`,
      );
    }
  }

  if (output.status === "refreshed") {
    if (
      previous === null ||
      previous.kind !== "upsert" ||
      current.kind !== "upsert" ||
      previous.eventTime !== current.eventTime
    ) {
      throw new ProviderContractError("A refreshed result must preserve an equal upsert watermark");
    }
  }

  if (!flags.changed && (previous === null || !sameWatermark(previous, current))) {
    throw new ProviderContractError("An unchanged transition must report identical previous and current watermarks");
  }

  return Object.freeze({
    status: output.status,
    accepted: flags.accepted,
    changed: flags.changed,
    previous,
    current,
  });
};

const normalizeStoredRecord = (record, key) => {
  if (record === null) return null;
  const input = requireObject(record, "provider record");
  const output = {
    key,
    kind: requireKind(input.kind, "record.kind"),
    eventTime: requireFiniteNumber(input.eventTime, "record.eventTime"),
    receivedAt: requireFiniteNumber(input.receivedAt, "record.receivedAt"),
  };

  if (hasOwn(input, "operationId") && input.operationId !== undefined) {
    if (typeof input.operationId !== "string" || input.operationId.length === 0) {
      throw new ProviderContractError("record.operationId must be a non-empty string");
    }
    output.operationId = input.operationId;
  }
  if (hasOwn(input, "reason") && input.reason !== undefined) {
    if (typeof input.reason !== "string") {
      throw new ProviderContractError("record.reason must be a string");
    }
    output.reason = input.reason;
  }
  if (hasOwn(input, "value")) output.value = input.value;
  if (output.kind === "terminal" && hasOwn(output, "value")) {
    throw new ProviderContractError("terminal records cannot carry a value");
  }

  return Object.freeze(output);
};

const createEventWatermarkStore = ({ provider, clock = Date.now } = {}) => {
  if (!provider || typeof provider !== "object" || typeof provider.transition !== "function") {
    throw new TypeError("provider.transition must be a function");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const transition = async (input) => {
    const command = normalizeTransition(input, clock);
    const result = await provider.transition(command);
    return normalizeResult(result, command);
  };

  const get = async (key) => {
    const normalizedKey = requireKey(key);
    if (typeof provider.get !== "function") {
      throw new ProviderContractError("provider.get is not available");
    }
    return normalizeStoredRecord(await provider.get(normalizedKey), normalizedKey);
  };

  return Object.freeze({ transition, get });
};

module.exports = {
  POLICY_VERSION,
  TRANSITION_STATUSES,
  EventWatermarkError,
  ProviderContractError,
  CorruptStateError,
  OperationIdConflictError,
  decideTransition,
  createEventWatermarkStore,
};
