import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "event-watermark-store-package-"));

try {
  const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", directory], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const packed = JSON.parse(stdout);
  assert.equal(packed.length, 1);
  const tarball = path.join(directory, packed[0].filename);

  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "package-smoke", private: true, type: "module" }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-package-lock", tarball], {
    cwd: directory,
    encoding: "utf8",
  });

  const esm = `
    import { createEventWatermarkStore } from "event-watermark-store";
    import { createMemoryEventWatermarkProvider } from "event-watermark-store/memory";
    const provider = createMemoryEventWatermarkProvider();
    const store = createEventWatermarkStore({ provider, clock: () => 2 });
    const result = await store.transition({ key: "esm", kind: "upsert", eventTime: 1 });
    if (result.status !== "applied") process.exit(2);
  `;
  await run("node", ["--input-type=module", "--eval", esm], { cwd: directory });

  const commonjs = `
    const { createEventWatermarkStore } = require("event-watermark-store");
    const { createMemoryEventWatermarkProvider } = require("event-watermark-store/memory");
    const provider = createMemoryEventWatermarkProvider();
    const store = createEventWatermarkStore({ provider, clock: () => 2 });
    store.transition({ key: "cjs", kind: "terminal", eventTime: 1 }).then((result) => {
      if (result.status !== "applied") process.exit(2);
    });
  `;
  await run("node", ["--input-type=commonjs", "--eval", commonjs], { cwd: directory });

  const manifest = JSON.parse(
    await readFile(path.join(directory, "node_modules/event-watermark-store/package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.license, "ISC");
  assert.equal(manifest.engines.node, ">=20.19.0");
} finally {
  await rm(directory, { recursive: true, force: true });
}
