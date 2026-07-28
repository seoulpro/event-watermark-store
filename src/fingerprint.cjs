"use strict";

const { createHash } = require("node:crypto");

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const compareRepresentations = (left, right) => {
  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
};

const numberToken = (value) => {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-infinity";
  if (Object.is(value, -0)) return "0";
  return String(value);
};

const canonicalValueRepresentation = (value, ancestors = new Set()) => {
  if (value === null) return ["null"];

  switch (typeof value) {
    case "undefined":
      return ["undefined"];
    case "boolean":
      return ["boolean", value];
    case "number":
      return ["number", numberToken(value)];
    case "string":
      return ["string", value];
    case "bigint":
      return ["bigint", String(value)];
    case "symbol":
    case "function":
      throw new TypeError("operationId values cannot contain symbols or functions");
    default:
      break;
  }

  if (ancestors.has(value)) {
    throw new TypeError("operationId values cannot contain cycles");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(
          hasOwn(value, index)
            ? canonicalValueRepresentation(value[index], ancestors)
            : ["array-hole"],
        );
      }
      return ["array", items];
    }

    if (value instanceof Date) {
      const timestamp = value.getTime();
      return ["date", Number.isNaN(timestamp) ? "invalid" : value.toISOString()];
    }

    if (value instanceof RegExp) {
      return ["regexp", value.source, value.flags];
    }

    if (value instanceof Map) {
      const entries = [...value].map(([key, entryValue]) => [
        canonicalValueRepresentation(key, ancestors),
        canonicalValueRepresentation(entryValue, ancestors),
      ]);
      entries.sort(compareRepresentations);
      return ["map", entries];
    }

    if (value instanceof Set) {
      const entries = [...value].map((entry) =>
        canonicalValueRepresentation(entry, ancestors),
      );
      entries.sort(compareRepresentations);
      return ["set", entries];
    }

    if (value instanceof ArrayBuffer) {
      return ["array-buffer", Buffer.from(value).toString("base64")];
    }

    if (ArrayBuffer.isView(value)) {
      return [
        "array-buffer-view",
        value.constructor.name,
        Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
      ];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("operationId values must use deterministic built-in or plain-object values");
    }
    if (
      Object.getOwnPropertySymbols(value).some((symbol) =>
        Object.prototype.propertyIsEnumerable.call(value, symbol),
      )
    ) {
      throw new TypeError("operationId values cannot contain enumerable symbol keys");
    }

    return [
      "object",
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValueRepresentation(value[key], ancestors)]),
    ];
  } finally {
    ancestors.delete(value);
  }
};

const canonicalEncodeValue = (value) =>
  JSON.stringify(canonicalValueRepresentation(value));

const cloneCanonicalValue = (value, ancestors = new Set()) => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    if (typeof value === "symbol" || typeof value === "function") {
      throw new TypeError("operationId values cannot contain symbols or functions");
    }
    return value;
  }
  if (typeof value === "function") {
    throw new TypeError("operationId values cannot contain symbols or functions");
  }
  if (ancestors.has(value)) {
    throw new TypeError("operationId values cannot contain cycles");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (hasOwn(value, index)) {
          clone[index] = cloneCanonicalValue(value[index], ancestors);
        }
      }
      return clone;
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);
    if (value instanceof Map) {
      return new Map(
        [...value].map(([key, entryValue]) => [
          cloneCanonicalValue(key, ancestors),
          cloneCanonicalValue(entryValue, ancestors),
        ]),
      );
    }
    if (value instanceof Set) {
      return new Set(
        [...value].map((entry) => cloneCanonicalValue(entry, ancestors)),
      );
    }
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (Buffer.isBuffer(value)) return Buffer.from(bytes);
      const buffer = Uint8Array.from(bytes).buffer;
      if (value instanceof DataView) return new DataView(buffer);
      return new value.constructor(buffer);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("operationId values must use deterministic built-in or plain-object values");
    }
    if (
      Object.getOwnPropertySymbols(value).some((symbol) =>
        Object.prototype.propertyIsEnumerable.call(value, symbol),
      )
    ) {
      throw new TypeError("operationId values cannot contain enumerable symbol keys");
    }
    const clone = Object.create(prototype);
    for (const key of Object.keys(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneCanonicalValue(value[key], ancestors),
        writable: true,
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
};

const OMIT_JSON_VALUE = Symbol("omit-json-value");

const normalizeStableJsonValue = (
  input,
  key,
  ancestors = new Set(),
  applyToJson = true,
) => {
  let value = input;
  if (
    applyToJson &&
    value !== null &&
    (typeof value === "object" || typeof value === "bigint") &&
    typeof value.toJSON === "function"
  ) {
    value = value.toJSON(key);
    return normalizeStableJsonValue(value, key, ancestors, false);
  }

  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return OMIT_JSON_VALUE;
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("value must not contain cycles");
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => {
        const item = normalizeStableJsonValue(value[index], String(index), ancestors);
        return item === OMIT_JSON_VALUE ? null : item;
      });
    }

    if (
      value instanceof Number ||
      value instanceof String ||
      value instanceof Boolean
    ) {
      return value.valueOf();
    }
    if (Object.prototype.toString.call(value) === "[object BigInt]") {
      return value.valueOf();
    }

    const output = Object.create(null);
    for (const property of Object.keys(value).sort()) {
      const normalized = normalizeStableJsonValue(
        value[property],
        property,
        ancestors,
      );
      if (normalized !== OMIT_JSON_VALUE) output[property] = normalized;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
};

const stableJsonEncode = (value) => {
  const normalized = normalizeStableJsonValue(value, "");
  return normalized === OMIT_JSON_VALUE ? undefined : JSON.stringify(normalized);
};

const createOperationFingerprint = (command, encodedValue) => {
  if (typeof encodedValue !== "string") {
    throw new TypeError("operation fingerprint value encoding must be a string");
  }
  const identity = JSON.stringify([
    "event-watermark-store:operation-fingerprint:1",
    command.kind,
    numberToken(command.eventTime),
    command.valuePresent,
    command.valuePresent ? encodedValue : "",
    command.reason !== undefined,
    command.reason ?? "",
  ]);
  return createHash("sha256").update(identity, "utf8").digest("hex");
};

module.exports = {
  canonicalEncodeValue,
  cloneCanonicalValue,
  createOperationFingerprint,
  stableJsonEncode,
};
