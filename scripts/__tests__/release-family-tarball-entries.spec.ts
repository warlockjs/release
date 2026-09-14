import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { inspectArtifact } from "../release-family.ts";
import {
  assertTarballContainsItsEntryPoints,
  collectTarballEntryTargets,
} from "../tarball-entry-points.mjs";

/**
 * Builds a minimal (but real, gzip-decodable, tar-walkable) tarball from a
 * flat list of {name, content} entries, exactly the shape
 * `release-family.ts`'s own `inspectArtifact` walks: a 500-byte USTAR-ish
 * header per entry (name at 0-100, octal size at 124-136, empty prefix at
 * 345-500) followed by the content padded to a 512-byte boundary, and two
 * trailing zero blocks marking end-of-archive.
 */
function buildTarballBuffer(files: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const nameBytes = Buffer.from(file.name, "utf8");
    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));
    const contentBytes = Buffer.from(file.content, "utf8");
    const sizeField = `${contentBytes.length.toString(8).padStart(11, "0")}\0`;
    header.write(sizeField, 124, "utf8");
    blocks.push(header);

    const paddedLength = Math.ceil(contentBytes.length / 512) * 512;
    const body = Buffer.alloc(paddedLength);
    contentBytes.copy(body, 0);
    blocks.push(body);
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
}

async function writeTarballFixture(
  directory: string,
  fileName: string,
  files: ReadonlyArray<{ name: string; content: string }>,
): Promise<string> {
  const tarballPath = path.join(directory, fileName);
  await writeFile(tarballPath, gzipSync(buildTarballBuffer(files)));
  return tarballPath;
}

const GUILTY_MANIFEST = {
  name: "@warlock.js/hollow-example",
  version: "1.0.0",
  main: "./esm/index.js",
  types: "./esm/index.d.ts",
  exports: {
    ".": {
      import: "./esm/index.js",
      types: "./esm/index.d.ts",
    },
  },
};

function manifestJson(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest, null, 2);
}

describe("assertTarballContainsItsEntryPoints (pure function)", () => {
  it("throws naming the package, the missing paths, and that the tarball is hollow", () => {
    assert.throws(
      () =>
        assertTarballContainsItsEntryPoints(
          "@warlock.js/hollow-example",
          GUILTY_MANIFEST,
          new Set(["package/package.json", "package/README.md"]),
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /@warlock.js\/hollow-example/);
        assert.match(error.message, /esm\/index\.js/);
        assert.match(error.message, /esm\/index\.d\.ts/);
        assert.match(error.message, /hollow/i);
        assert.match(error.message, /files.*\.npmignore|\.npmignore.*files/i);
        return true;
      },
    );
  });

  it("does not throw when every declared entry point is present in the tarball", () => {
    assert.doesNotThrow(() =>
      assertTarballContainsItsEntryPoints(
        "@warlock.js/hollow-example",
        GUILTY_MANIFEST,
        new Set([
          "package/package.json",
          "package/esm/index.js",
          "package/esm/index.d.ts",
        ]),
      ),
    );
  });

  it("checks a string bin and throws when it is missing", () => {
    assert.throws(
      () =>
        assertTarballContainsItsEntryPoints(
          "@warlock.js/hollow-cli",
          { name: "@warlock.js/hollow-cli", version: "1.0.0", bin: "./bin/cli.js" },
          new Set(["package/package.json"]),
        ),
      /bin\/cli\.js/,
    );
  });

  it("checks an object bin map and throws only for the missing binary", () => {
    assert.throws(
      () =>
        assertTarballContainsItsEntryPoints(
          "@warlock.js/hollow-cli",
          {
            name: "@warlock.js/hollow-cli",
            version: "1.0.0",
            bin: { warlock: "./bin/warlock.js", "warlock-doctor": "./bin/doctor.js" },
          },
          new Set(["package/package.json", "package/bin/warlock.js"]),
        ),
      /bin\/doctor\.js/,
    );
  });

  it("does not throw when every bin entry (string or object form) is present", () => {
    assert.doesNotThrow(() =>
      assertTarballContainsItsEntryPoints(
        "@warlock.js/hollow-cli",
        {
          name: "@warlock.js/hollow-cli",
          version: "1.0.0",
          bin: { warlock: "./bin/warlock.js" },
        },
        new Set(["package/package.json", "package/bin/warlock.js"]),
      ),
    );
    assert.doesNotThrow(() =>
      assertTarballContainsItsEntryPoints(
        "@warlock.js/hollow-cli",
        { name: "@warlock.js/hollow-cli", version: "1.0.0", bin: "./bin/cli.js" },
        new Set(["package/package.json", "package/bin/cli.js"]),
      ),
    );
  });

  it("ignores a '*' glob export subpath and a null export target", () => {
    const manifest = {
      name: "@warlock.js/hollow-glob",
      version: "1.0.0",
      exports: {
        ".": "./index.js",
        "./*": "./dist/*.js",
        "./internal": null,
      },
    };
    assert.doesNotThrow(() =>
      assertTarballContainsItsEntryPoints(
        "@warlock.js/hollow-glob",
        manifest,
        new Set(["package/package.json", "package/index.js"]),
      ),
    );
  });

  it("normalises a leading './' and a bare relative path to the same target", () => {
    const withDot = { name: "x", version: "1.0.0", main: "./index.js" };
    const withoutDot = { name: "x", version: "1.0.0", main: "index.js" };
    const entries = new Set(["package/package.json", "package/index.js"]);
    assert.doesNotThrow(() => assertTarballContainsItsEntryPoints("x", withDot, entries));
    assert.doesNotThrow(() => assertTarballContainsItsEntryPoints("x", withoutDot, entries));
  });

  it("collectTarballEntryTargets reports the full declared surface, including bin", () => {
    const targets = collectTarballEntryTargets({
      name: "x",
      version: "1.0.0",
      main: "./index.js",
      bin: { x: "./bin/x.js" },
    });
    assert.ok(targets.has("./index.js"));
    assert.ok(targets.has("./bin/x.js"));
  });
});

describe("hollow-tarball guard, wired through the real inspectArtifact", () => {
  it("(GUILTY) throws when a real tarball is packed without its declared entry files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "warlock-hollow-tarball-"));
    try {
      const tarballPath = await writeTarballFixture(directory, "guilty.tgz", [
        { name: "package/package.json", content: manifestJson(GUILTY_MANIFEST) },
        { name: "package/README.md", content: "# hollow\n" },
      ]);
      await assert.rejects(inspectArtifact(tarballPath), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /@warlock.js\/hollow-example/);
        assert.match(error.message, /hollow/i);
        assert.match(error.message, /esm\/index\.js/);
        return true;
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("(INNOCENT) does not throw when the real tarball actually contains its entry files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "warlock-hollow-tarball-"));
    try {
      const tarballPath = await writeTarballFixture(directory, "innocent.tgz", [
        { name: "package/package.json", content: manifestJson(GUILTY_MANIFEST) },
        { name: "package/README.md", content: "# not hollow\n" },
        { name: "package/esm/index.js", content: "export const ok = true;\n" },
        { name: "package/esm/index.d.ts", content: "export declare const ok: boolean;\n" },
      ]);
      const inspection = await inspectArtifact(tarballPath);
      assert.equal(inspection.manifest.name, "@warlock.js/hollow-example");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
