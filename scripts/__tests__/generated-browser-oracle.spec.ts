/**
 * WARLOCK_GENERATED_BROWSER_ORACLE — unit coverage for the pure/decidable
 * parts of `adapters/generated-browser-oracle.mjs` that do not require a
 * real Chrome/Chromium install or a booted `warlock dev`/`warlock build`:
 *
 *  - argument handling (delegated to, and shared with, `oracle-arguments.mjs`);
 *  - page discovery and route resolution against a synthetic generated-app tree;
 *  - mutation-token selection against real page source (the actual
 *    `webHomePageStub` template from `core/src/generations/stubs.ts`, and a
 *    negative case with no incrementing counter);
 *  - certificate shape construction and validation;
 *  - `--mutation-control` outcome decisions: the required
 *    `ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED` marker is emitted when the
 *    corruption WAS detected, and deliberately withheld when it was not — the
 *    gate matches on that marker, so withholding it is what makes an undetected
 *    corruption fail the gate rather than satisfy it.
 *
 * Browser orchestration (`driveBrowserPhase`, `runDevelopmentPhase`,
 * `runProductionPhase`, `main`) is exercised end-to-end only by actually
 * running the gate, which this spec does not attempt — that would require a
 * real generated app, an installed Chrome, and several minutes of npm/dev
 * server/build/start wall-clock time per case.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseOracleArguments } from "../adapters/oracle-arguments.mjs";
import {
  buildCertificate,
  counterAdvancedByOne,
  decideOutcome,
  deriveFilesystemRoutePath,
  discoverPages,
  extractCounterValue,
  extractDeclaredRoutePath,
  findHomePage,
  findIncrementMutationCandidate,
  phaseFullyPassed,
  resolvePageRoutePath,
} from "../adapters/generated-browser-oracle.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeAppRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "generated-browser-oracle-spec-"));
  temporaryRoots.push(root);
  return root;
}

describe("argument handling (shared oracle-arguments.mjs)", () => {
  it("accepts the exact vector the gate builds, without --mutation-control", () => {
    const parsed = parseOracleArguments([
      "--app-root",
      "/apps/case-1",
      "--baseline-root",
      "/apps/baseline",
      "--features-json",
      JSON.stringify(["auth"]),
      "--candidate-version",
      "5.3.2",
      "--format",
      "json",
    ]);
    assert.equal(parsed.appRoot, "/apps/case-1");
    assert.equal(parsed.baselineRoot, "/apps/baseline");
    assert.deepEqual(parsed.features, ["auth"]);
    assert.equal(parsed.candidateVersion, "5.3.2");
    assert.equal(parsed.mutationControl, false);
  });

  it("sets mutationControl when --mutation-control is appended, as the gate does for the red control", () => {
    const parsed = parseOracleArguments([
      "--app-root",
      "/apps/case-1",
      "--baseline-root",
      "/apps/baseline",
      "--features-json",
      "[]",
      "--candidate-version",
      "5.3.2",
      "--format",
      "json",
      "--mutation-control",
    ]);
    assert.equal(parsed.mutationControl, true);
  });

  it("rejects a missing required flag", () => {
    assert.throws(
      () =>
        parseOracleArguments([
          "--baseline-root",
          "/apps/baseline",
          "--features-json",
          "[]",
          "--candidate-version",
          "5.3.2",
          "--format",
          "json",
        ]),
      /--app-root is required/,
    );
  });
});

describe("discoverPages / route resolution", () => {
  it("finds every *.page.tsx beneath src/web, excluding error.page.tsx and 404.page.tsx", async () => {
    const appRoot = await makeAppRoot();
    await mkdir(path.join(appRoot, "src", "web", "products"), { recursive: true });
    await writeFile(
      path.join(appRoot, "src", "web", "index.page.tsx"),
      'export const route = { path: "/", name: "index" } as const;\nexport default function Home() { return null; }\n',
    );
    await writeFile(path.join(appRoot, "src", "web", "error.page.tsx"), "export default function E() { return null; }\n");
    await writeFile(path.join(appRoot, "src", "web", "404.page.tsx"), "export default function NF() { return null; }\n");
    await writeFile(
      path.join(appRoot, "src", "web", "products", "[id].page.tsx"),
      "export default function P() { return null; }\n",
    );

    const pages = await discoverPages(appRoot);
    const relatives = pages.map(page => page.relativeToWebRoot).sort();
    assert.deepEqual(relatives, ["index.page.tsx", "products/[id].page.tsx"]);
  });

  it("resolves an explicit object-literal route over the filesystem-derived one", async () => {
    const appRoot = await makeAppRoot();
    await mkdir(path.join(appRoot, "src", "web"), { recursive: true });
    const file = path.join(appRoot, "src", "web", "about.page.tsx");
    await writeFile(file, 'export const route = { path: "/company/about", name: "about" } as const;\nexport default function A(){return null;}\n');
    const routePath = await resolvePageRoutePath({ absolutePath: file, relativeToWebRoot: "about.page.tsx" });
    assert.equal(routePath, "/company/about");
  });

  it("resolves a bare string route", async () => {
    const appRoot = await makeAppRoot();
    await mkdir(path.join(appRoot, "src", "web"), { recursive: true });
    const file = path.join(appRoot, "src", "web", "contact.page.tsx");
    await writeFile(file, 'export const route = "/contact";\nexport default function C(){return null;}\n');
    const routePath = await resolvePageRoutePath({ absolutePath: file, relativeToWebRoot: "contact.page.tsx" });
    assert.equal(routePath, "/contact");
  });

  it("derives the filesystem route when no route export is present", async () => {
    const appRoot = await makeAppRoot();
    await mkdir(path.join(appRoot, "src", "web", "products"), { recursive: true });
    const file = path.join(appRoot, "src", "web", "products", "[id].page.tsx");
    await writeFile(file, "export default function P() { return null; }\n");
    const routePath = await resolvePageRoutePath({ absolutePath: file, relativeToWebRoot: "products/[id].page.tsx" });
    assert.equal(routePath, "/products/:id");
  });

  it("derives '/' for a route-less src/web/index.page.tsx", () => {
    assert.equal(deriveFilesystemRoutePath("index.page.tsx"), "/");
  });

  it("drops (group) segments from the derived path", () => {
    assert.equal(deriveFilesystemRoutePath("(marketing)/pricing.page.tsx"), "/pricing");
  });

  it("finds the home page among several discovered routes", () => {
    const home = findHomePage([
      { absolutePath: "a", relativeToWebRoot: "products/index.page.tsx", routePath: "/products" },
      { absolutePath: "b", relativeToWebRoot: "index.page.tsx", routePath: "/" },
    ]);
    assert.equal(home?.relativeToWebRoot, "index.page.tsx");
  });

  it("returns undefined when nothing resolves to '/'", () => {
    const home = findHomePage([{ absolutePath: "a", relativeToWebRoot: "products/index.page.tsx", routePath: "/products" }]);
    assert.equal(home, undefined);
  });
});

describe("extractDeclaredRoutePath", () => {
  it("returns undefined for a page with no route export at all", () => {
    assert.equal(extractDeclaredRoutePath("export default function Page() { return null; }\n"), undefined);
  });

  it("returns undefined for an object route missing a literal path", () => {
    assert.equal(extractDeclaredRoutePath("export const route = { name: \"x\" } as const;\n"), undefined);
  });
});

describe("findIncrementMutationCandidate — real generated-app source", () => {
  it("finds the real setCount(c => c + 1) idiom in core's own webHomePageStub template", async () => {
    // This is the ACTUAL stub `warlock add web` writes to a generated app's
    // src/web/index.page.tsx (core/src/generations/stubs.ts) — not a fixture
    // invented for this spec. Reading it here proves the adapter's mutation
    // selection works against real generated-app content, not a stand-in.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const stubsFile = path.resolve(here, "..", "..", "..", "core", "src", "generations", "stubs.ts");
    const stubsSource = await readFile(stubsFile, "utf8");
    const start = stubsSource.indexOf("export const webHomePageStub");
    assert.ok(start >= 0, "webHomePageStub not found in core/src/generations/stubs.ts — has it moved?");
    const homePageSource = stubsSource.slice(start);

    const candidate = findIncrementMutationCandidate(homePageSource);
    assert.ok(candidate, "expected an increment candidate in the real webHomePageStub");

    // Assert the PROPERTIES the gate requires of a mutation, not a literal
    // token. This spec previously pinned `setCount(c => c + 1)` and went red
    // the moment the stub was formatted under the scaffold's own prettier
    // config (`arrowParens: "always"` makes it `setCount((c) => c + 1)`) —
    // even though the adapter was correct. A literal here pins the formatter,
    // not the behaviour.
    //
    // `proveBrowserMutation` (zero-edit-generator-gate.ts:282-310) requires
    // exactly this much: `find` occurs EXACTLY ONCE in the file, and
    // `replacement` differs from it.
    assert.equal(
      homePageSource.split(candidate!.find).length - 1,
      1,
      "the nominated token must occur exactly once — the gate refuses anything else",
    );
    assert.notEqual(candidate?.find, candidate?.replacement);
    // And it must really be the counter increment being neutralised.
    assert.match(candidate!.find, /setCount\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*\+\s*1\s*\)/);
    assert.ok(!/\+\s*1/.test(candidate!.replacement), "the replacement must stop incrementing");
    // The count-up button is the second <button> in the template (index 1):
    // the first is the language toggle above it in source order.
    assert.equal(candidate?.buttonIndex, 1);
  });

  it("returns undefined when the page has no useState counter idiom", () => {
    const source = `
      import { useState } from "react";
      export default function Page() {
        const [name, setName] = useState("");
        return <button onClick={() => setName("x")}>Set</button>;
      }
    `;
    assert.equal(findIncrementMutationCandidate(source), undefined);
  });

  it("returns undefined for a page with no useState at all", () => {
    assert.equal(findIncrementMutationCandidate("export default function Page() { return <button>Click</button>; }"), undefined);
  });
});

describe("extractCounterValue — reading the counter the way a user would", () => {
  it("extracts the counter's value from the real scaffold's container text with the button label removed", () => {
    // This is the literal text `driveBrowserPhase`'s readCounterContainerText
    // expression would produce for core's real webHomePageStub `.wk-check`
    // section — the button's own "Count up" label already stripped out.
    const containerText = "If this number goes up when you click, React is hydrated:0";
    assert.equal(extractCounterValue(containerText), 0);
  });

  it("extracts a multi-digit value after several increments", () => {
    assert.equal(extractCounterValue("If this number goes up when you click, React is hydrated:12"), 12);
  });

  it("throws COUNTER_VALUE_NOT_FOUND, naming the searched text, when no digits are present", () => {
    assert.throws(
      () => extractCounterValue("If this number goes up when you click, React is hydrated:"),
      /COUNTER_VALUE_NOT_FOUND/,
    );
  });
});

describe("counterAdvancedByOne — the actual pass/fail rule for the click assertion", () => {
  it("passes when the count went up by exactly one", () => {
    assert.equal(counterAdvancedByOne(0, 1), true);
    assert.equal(counterAdvancedByOne(7, 8), true);
  });

  it("fails when the count did not move at all — the exact shape of the real mutation-control corruption", () => {
    // setCount(c => c + 1) mutated to setCount(c => c): a click changes
    // nothing, so before/after are equal. This is the case the whole-page
    // text-diff this replaces could fail to catch if anything else on the
    // page happened to change; reading the counter specifically cannot.
    assert.equal(counterAdvancedByOne(0, 0), false);
    assert.equal(counterAdvancedByOne(5, 5), false);
  });

  it("fails on any jump other than exactly +1", () => {
    assert.equal(counterAdvancedByOne(0, 2), false);
    assert.equal(counterAdvancedByOne(3, 1), false);
  });

  it("fails when either reading is not an integer", () => {
    assert.equal(counterAdvancedByOne(Number.NaN, 1), false);
    assert.equal(counterAdvancedByOne(0, Number.NaN), false);
    assert.equal(counterAdvancedByOne(0.5, 1.5), false);
  });
});

describe("buildCertificate", () => {
  const development = {
    clickPassed: true,
    linkSpaNavigationPassed: true,
    hmrStatePreserved: true,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
  const production = {
    clickPassed: true,
    linkSpaNavigationPassed: true,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
  const mutation = { relativePath: "src/web/index.page.tsx", find: "setCount(c => c + 1)", replacement: "setCount(c => c)" };

  it("builds the exact schema the gate's parseBrowserCertificate requires", () => {
    const certificate = buildCertificate({ appRoot: path.resolve("/apps/case-1"), development, production, mutation });
    assert.equal(certificate.schemaVersion, 1);
    assert.equal(certificate.appRoot, path.resolve("/apps/case-1"));
    assert.deepEqual(certificate.development, development);
    assert.deepEqual(certificate.production, production);
    assert.deepEqual(certificate.mutation, mutation);
    assert.equal((certificate.production as Record<string, unknown>).hmrStatePreserved, undefined);
  });

  it("rejects a relative appRoot", () => {
    assert.throws(() => buildCertificate({ appRoot: "apps/case-1", development, production, mutation }), /absolute appRoot/);
  });

  it("rejects a development phase missing hmrStatePreserved", () => {
    const { hmrStatePreserved: _dropped, ...withoutHmr } = development;
    assert.throws(
      () => buildCertificate({ appRoot: path.resolve("/apps/case-1"), development: withoutHmr, production, mutation }),
      /hmrStatePreserved/,
    );
  });

  it("rejects an absolute mutation.relativePath", () => {
    assert.throws(
      () =>
        buildCertificate({
          appRoot: path.resolve("/apps/case-1"),
          development,
          production,
          mutation: { ...mutation, relativePath: path.resolve("/apps/case-1/src/web/index.page.tsx") },
        }),
      /relative to the app root/,
    );
  });

  it("rejects a mutation whose find equals its replacement", () => {
    assert.throws(
      () =>
        buildCertificate({
          appRoot: path.resolve("/apps/case-1"),
          development,
          production,
          mutation: { ...mutation, replacement: mutation.find },
        }),
      /distinct replacement/,
    );
  });
});

describe("phaseFullyPassed / decideOutcome", () => {
  const passingDevelopment = {
    clickPassed: true,
    linkSpaNavigationPassed: true,
    hmrStatePreserved: true,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
  const passingProduction = {
    clickPassed: true,
    linkSpaNavigationPassed: true,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
  const mutation = { relativePath: "src/web/index.page.tsx", find: "setCount(c => c + 1)", replacement: "setCount(c => c)" };

  it("phaseFullyPassed requires hmrStatePreserved only when asked for", () => {
    assert.equal(phaseFullyPassed(passingDevelopment, true), true);
    const { hmrStatePreserved: _unused, ...withoutHmr } = passingDevelopment;
    assert.equal(phaseFullyPassed({ ...withoutHmr, hmrStatePreserved: false }, false), true);
    assert.equal(phaseFullyPassed({ ...withoutHmr, hmrStatePreserved: false }, true), false);
  });

  it("phaseFullyPassed fails on any non-empty error array", () => {
    assert.equal(phaseFullyPassed({ ...passingProduction, consoleErrors: ["boom"] }, false), false);
    assert.equal(phaseFullyPassed({ ...passingProduction, pageErrors: ["boom"] }, false), false);
  });

  it("normal mode: passes silently (exit 0) when both phases fully pass", () => {
    const outcome = decideOutcome({ mutationControl: false, development: passingDevelopment, production: passingProduction, mutation });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
  });

  it("normal mode: fails with a plain diagnostic (no marker) when a phase fails honestly", () => {
    const failingDevelopment = { ...passingDevelopment, clickPassed: false };
    const outcome = decideOutcome({ mutationControl: false, development: failingDevelopment, production: passingProduction, mutation });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.ok(!outcome.message.includes("ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED"));
  });

  it("--mutation-control: exits non-zero WITH the required marker when the corruption is detected (the expected case)", () => {
    const corruptedDevelopment = { ...passingDevelopment, clickPassed: false };
    const outcome = decideOutcome({ mutationControl: true, development: corruptedDevelopment, production: passingProduction, mutation });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.ok(outcome.message.includes("ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED"));
    assert.ok(outcome.message.includes(mutation.find));
  });

  it("--mutation-control: WITHHOLDS the marker when the corruption went undetected, so the gate refuses a dead red control instead of accepting it", () => {
    // The gate accepts the control only on `exitCode !== 0 && /MARKER/`
    // (`zero-edit-generator-gate.ts:299-302`). Emitting the marker here would
    // report a working red control while the oracle had in fact proved nothing.
    const outcome = decideOutcome({ mutationControl: true, development: passingDevelopment, production: passingProduction, mutation });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.ok(!outcome.message.includes("ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED"));
    assert.ok(outcome.message.includes("ZERO_EDIT_BROWSER_ORACLE_CONTROL_NOT_DETECTED"));
    assert.ok(/did NOT detect/.test(outcome.message));
  });

  it("--mutation-control: a production-only failure is still reported as detected", () => {
    const corruptedProduction = { ...passingProduction, linkSpaNavigationPassed: false };
    const outcome = decideOutcome({ mutationControl: true, development: passingDevelopment, production: corruptedProduction, mutation });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.message.includes("ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED"));
    assert.ok(/correctly detected/.test(outcome.message));
  });
});
