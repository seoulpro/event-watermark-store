import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const npmEntryPoint = process.env.npm_execpath;
const temporary = await mkdtemp(
  path.join(tmpdir(), "event-watermark-store-package-"),
);
const packDirectory = path.join(temporary, "pack");
const consumerDirectory = path.join(temporary, "consumer");
const commandOptions = (cwd) => ({
  cwd,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
const runNpm = (arguments_, cwd) =>
  npmEntryPoint
    ? executeFile(
        process.execPath,
        [npmEntryPoint, ...arguments_],
        commandOptions(cwd),
      )
    : executeFile("npm", arguments_, commandOptions(cwd));

const requiredPaths = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "cache.cjs",
  "cache.d.cts",
  "cache.d.ts",
  "cache.js",
  "docs/DESIGN.md",
  "docs/LICENSE_NOTES.md",
  "docs/PRIOR_ART.md",
  "docs/SERVICE_COMPATIBILITY.md",
  "examples/basic.mjs",
  "fixtures/service-compatibility.json",
  "index.cjs",
  "index.d.cts",
  "index.d.ts",
  "index.js",
  "memory.cjs",
  "memory.d.cts",
  "memory.d.ts",
  "memory.js",
  "package.json",
  "redis.cjs",
  "redis.d.cts",
  "redis.d.ts",
  "redis.js",
  "src/cache.cjs",
  "src/core.cjs",
  "src/fingerprint.cjs",
  "src/key.cjs",
  "src/memory.cjs",
  "src/redis.cjs",
];

const isForbiddenPath = (packedPath) =>
  packedPath.startsWith(".") ||
  packedPath === "package-lock.json" ||
  packedPath === "tsconfig.json" ||
  packedPath.startsWith("node_modules/") ||
  packedPath.startsWith("scripts/") ||
  packedPath.startsWith("test/") ||
  packedPath.startsWith("test-d/") ||
  /\.(?:test|spec)\.[cm]?[jt]s$/u.test(packedPath) ||
  packedPath.endsWith(".tgz");

const assertNoRuntimeDependencies = (manifest) => {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.deepEqual(
      manifest[field] ?? {},
      {},
      `installed manifest has runtime ${field}`,
    );
  }
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    assert.deepEqual(
      manifest[field] ?? [],
      [],
      `installed manifest has ${field}`,
    );
  }
};

try {
  await Promise.all([
    mkdir(packDirectory),
    mkdir(consumerDirectory),
  ]);

  const sourceManifest = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  );
  const { stdout } = await runNpm(
    ["pack", ".", "--json", "--pack-destination", packDirectory],
    projectDirectory,
  );
  const packedArtifacts = JSON.parse(stdout);
  assert.equal(packedArtifacts.length, 1, "npm pack must produce one artifact");

  const [packed] = packedArtifacts;
  assert.equal(packed.name, sourceManifest.name);
  assert.equal(packed.version, sourceManifest.version);
  assert.deepEqual(packed.bundled ?? [], []);

  const packedPaths = packed.files.map(({ path: packedPath }) => packedPath);
  assert.equal(
    new Set(packedPaths).size,
    packedPaths.length,
    "packed artifact contains duplicate paths",
  );
  const packedPathSet = new Set(packedPaths);
  for (const requiredPath of requiredPaths) {
    assert.ok(
      packedPathSet.has(requiredPath),
      `packed artifact is missing ${requiredPath}`,
    );
  }
  for (const packedPath of packedPaths) {
    assert.equal(
      isForbiddenPath(packedPath),
      false,
      `packed artifact contains forbidden path ${packedPath}`,
    );
  }

  const tarball = path.join(packDirectory, packed.filename);
  assert.equal(
    (await stat(tarball)).size,
    packed.size,
    "reported package size does not match the tarball",
  );

  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "event-watermark-store-package-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    consumerDirectory,
  );

  const installedDirectory = path.join(
    consumerDirectory,
    "node_modules",
    sourceManifest.name,
  );
  const installedStats = await lstat(installedDirectory);
  assert.equal(installedStats.isDirectory(), true);
  assert.equal(
    installedStats.isSymbolicLink(),
    false,
    "tarball install must not create a linked package",
  );
  await Promise.all(
    requiredPaths.map((requiredPath) =>
      access(path.join(installedDirectory, requiredPath)),
    ),
  );

  const installedManifest = JSON.parse(
    await readFile(path.join(installedDirectory, "package.json"), "utf8"),
  );
  assert.equal(installedManifest.name, "event-watermark-store");
  assert.equal(installedManifest.version, sourceManifest.version);
  assert.equal(installedManifest.license, "ISC");
  assert.deepEqual(installedManifest.engines, { node: ">=20.19.0" });
  assertNoRuntimeDependencies(installedManifest);

  const dependencyTree = JSON.parse(
    (
      await runNpm(
        ["ls", "--omit=dev", "--all", "--json"],
        consumerDirectory,
      )
    ).stdout,
  );
  assert.deepEqual(
    Object.keys(dependencyTree.dependencies ?? {}),
    ["event-watermark-store"],
  );
  assert.deepEqual(
    dependencyTree.dependencies["event-watermark-store"].dependencies ?? {},
    {},
  );

  const esmConsumer = `
    import assert from "node:assert/strict";
    import {
      POLICY_VERSION,
      createEventWatermarkStore,
    } from "event-watermark-store";
    import {
      createMemoryEventWatermarkProvider,
    } from "event-watermark-store/memory";
    import {
      REDIS_SCHEMA_VERSION,
      createIoRedisExecutor,
      createRedisEventWatermarkProvider,
    } from "event-watermark-store/redis";
    import {
      createCoalescedSnapshotReader,
    } from "event-watermark-store/cache";

    assert.equal(POLICY_VERSION, 1);
    const provider = createMemoryEventWatermarkProvider();
    const store = createEventWatermarkStore({ provider, clock: () => 2 });
    const result = await store.transition({
      key: "esm",
      kind: "upsert",
      eventTime: 1,
      value: { reading: 3 },
    });
    assert.equal(result.status, "applied");
    assert.deepEqual((await store.get("esm")).value, { reading: 3 });

    let reads = 0;
    const readSnapshot = createCoalescedSnapshotReader({
      read: async () => ++reads,
      ttlMs: 10,
      now: () => 0,
    });
    assert.equal(await readSnapshot(), 1);
    assert.equal(await readSnapshot(), 1);
    assert.equal(reads, 1);
    readSnapshot.invalidate();
    assert.equal(await readSnapshot(), 2);

    const redisProvider = createRedisEventWatermarkProvider({
      execute: async () => {
        throw new Error("package smoke must not contact Redis");
      },
    });
    assert.match(redisProvider.keyFor("esm"), /^event-watermark:/u);
    assert.equal(REDIS_SCHEMA_VERSION, "2");

    const calls = [];
    const execute = createIoRedisExecutor({
      eval: async (...arguments_) => {
        calls.push(arguments_);
        return "ok";
      },
    });
    assert.equal(
      await execute({
        script: "return 1",
        keys: ["key"],
        arguments: ["argument"],
      }),
      "ok",
    );
    assert.deepEqual(calls, [["return 1", 1, "key", "argument"]]);
  `;
  await executeFile(
    process.execPath,
    ["--input-type=module", "--eval", esmConsumer],
    commandOptions(consumerDirectory),
  );

  const commonJsConsumer = `
    const assert = require("node:assert/strict");
    const {
      TRANSITION_STATUSES,
      createEventWatermarkStore,
    } = require("event-watermark-store");
    const {
      createMemoryEventWatermarkProvider,
    } = require("event-watermark-store/memory");
    const {
      REDIS_READ_PROTOCOL,
      createNodeRedisExecutor,
      createRedisEventWatermarkProvider,
    } = require("event-watermark-store/redis");
    const {
      createCoalescedSnapshotReader,
    } = require("event-watermark-store/cache");

    void (async () => {
      assert.ok(TRANSITION_STATUSES.includes("applied"));
      const provider = createMemoryEventWatermarkProvider();
      const store = createEventWatermarkStore({ provider, clock: () => 2 });
      const result = await store.transition({
        key: "commonjs",
        kind: "terminal",
        eventTime: 1,
        reason: "complete",
      });
      assert.equal(result.status, "applied");
      assert.equal((await store.get("commonjs")).reason, "complete");

      let reads = 0;
      const readSnapshot = createCoalescedSnapshotReader({
        read: async () => ++reads,
        ttlMs: 10,
        now: () => 0,
      });
      assert.equal(await readSnapshot(), 1);
      assert.equal(await readSnapshot(), 1);
      assert.equal(reads, 1);

      const redisProvider = createRedisEventWatermarkProvider({
        execute: async () => {
          throw new Error("package smoke must not contact Redis");
        },
      });
      assert.match(redisProvider.keyFor("commonjs"), /^event-watermark:/u);
      assert.equal(
        REDIS_READ_PROTOCOL,
        "event-watermark-store:read:2",
      );

      const calls = [];
      const execute = createNodeRedisExecutor({
        eval: async (...arguments_) => {
          calls.push(arguments_);
          return "ok";
        },
      });
      assert.equal(
        await execute({
          script: "return 1",
          keys: ["key"],
          arguments: ["argument"],
        }),
        "ok",
      );
      assert.deepEqual(calls, [[
        "return 1",
        { keys: ["key"], arguments: ["argument"] },
      ]]);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  await executeFile(
    process.execPath,
    ["--input-type=commonjs", "--eval", commonJsConsumer],
    commandOptions(consumerDirectory),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
