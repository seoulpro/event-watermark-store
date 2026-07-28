import assert from "node:assert/strict";
import test from "node:test";

import fingerprint from "../src/fingerprint.cjs";

const {
  canonicalEncodeValue,
  cloneCanonicalValue,
  createOperationFingerprint,
  stableJsonEncode,
} = fingerprint;

test("operation fingerprints are canonical across supported value shapes", () => {
  assert.equal(
    canonicalEncodeValue({ b: 2, a: [true, undefined, null] }),
    canonicalEncodeValue({ a: [true, undefined, null], b: 2 }),
  );
  assert.equal(
    canonicalEncodeValue(new Map([["b", 2], ["a", 1]])),
    canonicalEncodeValue(new Map([["a", 1], ["b", 2]])),
  );
  assert.equal(
    canonicalEncodeValue(new Set(["b", "a"])),
    canonicalEncodeValue(new Set(["a", "b"])),
  );
  assert.doesNotThrow(() =>
    canonicalEncodeValue(new Map([[{}, 1], [{}, 1]])),
  );

  const buffer = new Uint8Array([1, 2, 3]).buffer;
  const supported = [
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    new Date("2026-01-02T03:04:05.000Z"),
    new Date(Number.NaN),
    /watermark/giu,
    buffer,
    new Uint8Array(buffer),
    Object.assign(Object.create(null), { value: "plain" }),
  ];
  for (const value of supported) {
    assert.equal(typeof canonicalEncodeValue(value), "string");
    assert.doesNotThrow(() => cloneCanonicalValue(value));
  }

  const sparse = [];
  sparse.length = 1;
  assert.notEqual(canonicalEncodeValue(sparse), canonicalEncodeValue([undefined]));
  const sparseClone = cloneCanonicalValue(sparse);
  assert.equal(0 in sparseClone, false);
});

test("operation fingerprint rejects values without stable identity", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  class CustomValue {}
  const symbolKeyed = {};
  symbolKeyed[Symbol("key")] = true;

  for (const value of [Symbol("value"), () => {}, cyclic, new CustomValue(), symbolKeyed]) {
    assert.throws(() => canonicalEncodeValue(value), TypeError);
    assert.throws(() => cloneCanonicalValue(value), TypeError);
  }
  assert.throws(
    () =>
      createOperationFingerprint(
        {
          kind: "upsert",
          eventTime: 1,
          valuePresent: true,
          reason: undefined,
        },
        1,
      ),
    /encoding must be a string/,
  );
});

test("canonical snapshots detach every supported mutable container", () => {
  const source = {
    array: [{ value: 1 }],
    date: new Date("2026-01-02T03:04:05.000Z"),
    expression: /watermark/gi,
    map: new Map([["key", { value: 2 }]]),
    set: new Set([{ value: 3 }]),
    buffer: Buffer.from([1, 2]),
    dataView: new DataView(new Uint8Array([3, 4]).buffer),
    typed: new Uint16Array([5, 6]),
    bytes: new Uint8Array([7, 8]).buffer,
  };
  const snapshot = cloneCanonicalValue(source);

  source.array[0].value = 9;
  source.map.get("key").value = 9;
  [...source.set][0].value = 9;
  source.buffer[0] = 9;
  source.dataView.setUint8(0, 9);
  source.typed[0] = 9;

  assert.equal(snapshot.array[0].value, 1);
  assert.equal(snapshot.map.get("key").value, 2);
  assert.equal([...snapshot.set][0].value, 3);
  assert.deepEqual([...snapshot.buffer], [1, 2]);
  assert.equal(snapshot.dataView.getUint8(0), 3);
  assert.deepEqual([...snapshot.typed], [5, 6]);
  assert.notEqual(snapshot.bytes, source.bytes);
  assert.notEqual(snapshot.date, source.date);
  assert.notEqual(snapshot.expression, source.expression);
});

test("stable JSON encoding sorts keys while preserving JSON presence rules", () => {
  assert.equal(
    stableJsonEncode({ z: 1, nested: { b: 2, a: 1 } }),
    '{"nested":{"a":1,"b":2},"z":1}',
  );
  assert.equal(
    stableJsonEncode({ omitted: undefined, array: [undefined, () => {}] }),
    '{"array":[null,null]}',
  );
  assert.equal(stableJsonEncode(new Number(3)), "3");
  assert.equal(stableJsonEncode(new String("value")), '"value"');
  assert.equal(stableJsonEncode(new Boolean(true)), "true");
  assert.equal(
    stableJsonEncode({ when: new Date("2026-01-02T03:04:05.000Z") }),
    '{"when":"2026-01-02T03:04:05.000Z"}',
  );
  assert.equal(stableJsonEncode(undefined), undefined);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableJsonEncode(cyclic), /cycles/);
  assert.throws(() => stableJsonEncode(1n), TypeError);
  assert.throws(() => stableJsonEncode(Object(1n)), TypeError);
});

test("dangerous plain-object keys remain own data without prototype mutation", () => {
  const value = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}',
  );
  const encoded = stableJsonEncode(value);
  assert.equal(
    encoded,
    '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}',
  );
  assert.equal(stableJsonEncode(JSON.parse(encoded)), encoded);
  assert.notEqual(encoded, stableJsonEncode({}));

  const clone = cloneCanonicalValue(value);
  assert.equal(Object.getPrototypeOf(clone), Object.prototype);
  assert.equal(Object.hasOwn(clone, "__proto__"), true);
  assert.deepEqual(clone.__proto__, { polluted: true });
  assert.equal(clone.constructor, 1);
  assert.equal(clone.prototype, 2);
  assert.equal(Object.prototype.polluted, undefined);

  const command = {
    kind: "upsert",
    eventTime: 1,
    valuePresent: true,
    reason: undefined,
  };
  assert.notEqual(
    createOperationFingerprint(command, canonicalEncodeValue(value)),
    createOperationFingerprint(command, canonicalEncodeValue({})),
  );
});

test("operation fingerprint excludes receivedAt but binds value and reason presence", () => {
  const command = {
    kind: "upsert",
    eventTime: 1,
    receivedAt: 10,
    valuePresent: true,
    reason: undefined,
  };
  const initial = createOperationFingerprint(command, '{"value":1}');

  assert.equal(
    initial,
    createOperationFingerprint({ ...command, receivedAt: 999 }, '{"value":1}'),
  );
  assert.notEqual(initial, createOperationFingerprint(command, '{"value":2}'));
  assert.notEqual(
    initial,
    createOperationFingerprint({ ...command, valuePresent: false }, ""),
  );
  assert.notEqual(
    initial,
    createOperationFingerprint({ ...command, reason: "" }, '{"value":1}'),
  );
});
