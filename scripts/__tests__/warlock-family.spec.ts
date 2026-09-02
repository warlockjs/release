import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  deriveWarlockFamily,
  loadAuthoritativeWarlockFamily,
  type WarlockFamilyDeclaration,
} from "../warlock-family.ts";

const FAMILY_NAMES = [
  "@warlock.js/access",
  "@warlock.js/ai",
  "@warlock.js/ai-anthropic",
  "@warlock.js/ai-bedrock",
  "@warlock.js/ai-deepseek",
  "@warlock.js/ai-google",
  "@warlock.js/ai-groq",
  "@warlock.js/ai-live",
  "@warlock.js/ai-mistral",
  "@warlock.js/ai-ollama",
  "@warlock.js/ai-openai",
  "@warlock.js/ai-panoptic",
  "@warlock.js/ai-tools",
  "@warlock.js/ai-workspace",
  "@warlock.js/ai-xai",
  "@warlock.js/auth",
  "@warlock.js/cache",
  "@warlock.js/cascade",
  "@warlock.js/context",
  "@warlock.js/core",
  "@warlock.js/fs",
  "@warlock.js/herald",
  "@warlock.js/logger",
  "@warlock.js/notifications",
  "@warlock.js/scheduler",
  "@warlock.js/seal",
  "@warlock.js/web",
  "create-warlock",
] as const;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  );
});

test("loads the authoritative family and keeps Web/Core late and create-warlock last", async () => {
  const family = await loadAuthoritativeWarlockFamily();

  assert.equal(family.members.length, 28);
  assert.deepEqual(
    family.members.slice(-3).map(member => member.name),
    ["@warlock.js/web", "@warlock.js/core", "create-warlock"],
  );
  assert.ok(family.members.every(member => member.version === family.version));
});

test("reports a name-set mismatch before the count backstop", async () => {
  const fixture = await createFixture();
  const packages = fixture.declaration.packages.map(member => ({ ...member }));
  packages[0] = { name: "@warlock.js/not-a-real-member", root: packages[0].root };

  await assert.rejects(
    deriveWarlockFamily({
      ...fixture,
      declaration: { name: "warlock", packages },
    }),
    error => {
      assert.match(String(error), /name-set mismatch/);
      assert.doesNotMatch(String(error), /size invariant/);
      return true;
    },
  );
});

test("reports configured-root drift", async () => {
  const fixture = await createFixture();
  const packages = fixture.declaration.packages.map(member => ({ ...member }));
  packages[0] = { ...packages[0], root: "../wrong-root" };

  await assert.rejects(
    deriveWarlockFamily({
      ...fixture,
      declaration: { name: "warlock", packages },
    }),
    /root mismatch/,
  );
});

test("reports source version skew", async () => {
  const fixture = await createFixture();
  const skewed = fixture.declaration.packages[0];
  await writeManifest(path.resolve(fixture.configDir, skewed.root), skewed.name, "9.9.8");

  await assert.rejects(deriveWarlockFamily(fixture), /lockstep version mismatch/);
});

test("uses 28 only as a secondary invariant after matching semantic sources", async () => {
  const fixture = await createFixture(FAMILY_NAMES.slice(0, -1));

  await assert.rejects(deriveWarlockFamily(fixture), /size invariant.*expected 28, found 27/);
});

async function createFixture(
  names: readonly string[] = FAMILY_NAMES,
): Promise<{
  workspaceRoot: string;
  configDir: string;
  declaration: WarlockFamilyDeclaration;
}> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "warlock-family-spec-"));
  temporaryRoots.push(workspaceRoot);
  const configDir = path.join(workspaceRoot, "builder");
  await mkdir(configDir, { recursive: true });

  const packages = [];
  for (const [index, name] of names.entries()) {
    const folder = `package-${String(index).padStart(2, "0")}`;
    const root = path.join(workspaceRoot, folder);
    await writeManifest(root, name, "9.9.9");
    packages.push({ name, root: `../${folder}` });
  }

  return {
    workspaceRoot,
    configDir,
    declaration: { name: "warlock", packages },
  };
}

async function writeManifest(root: string, name: string, version: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
    "utf8",
  );
}
