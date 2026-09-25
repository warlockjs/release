/**
 * WARLOCK_GENERATED_OUTPUT_ORACLE — verification.
 *
 * This suite unit-tests every pure piece the oracle exports (route-id
 * construction, route-inventory diffing, param substitution, the
 * requested/not-requested status rule, project-command diffing, `hasWeb`
 * detection, and certificate assembly) and drives the adapter as a real
 * child process for its argument-validation failure paths.
 *
 * It does NOT exercise the oracle end-to-end against a real generated app
 * (no `npm install`, no `warlock dev`/`build`/`start`, no real HTTP
 * lifecycle) — see this file's own header comment in
 * `generated-output-oracle.mjs` for why that requires a real generated app
 * and baseline plus installed `@warlock.js/core`, which this suite does not
 * scaffold. That gap is reported plainly rather than implied away.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after, before } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assembleCertificate,
  detectHasWeb,
  diffProjectCommands,
  diffRoutes,
  isRequestedStatus,
  routeId,
  substituteRouteParams,
} from "../adapters/generated-output-oracle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = path.resolve(HERE, "..", "adapters", "generated-output-oracle.mjs");

function run(args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ORACLE, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.once("error", reject);
    child.once("close", exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

describe("routeId", () => {
  it("joins method and path with a space, order-sensitive", () => {
    assert.equal(routeId("GET", "/users/:id"), "GET /users/:id");
    assert.notEqual(routeId("GET", "/users/:id"), routeId("get", "/users/:id"));
  });
});

describe("diffRoutes", () => {
  const row = (method: string, routePath: string) => ({
    method,
    path: routePath,
    name: "",
    action: "anonymous",
    middleware: 0,
    source: "",
  });

  it("never counts a framework-synthetic (virtual \\0 source) route as introduced", () => {
    const catchAll = { ...row("GET", "/*"), source: "\0warlock:framework-default-404" };
    const app = [row("GET", "/"), catchAll, row("GET", "/welcome")];
    const baseline = [row("GET", "/")];
    assert.deepEqual(diffRoutes(app, baseline), [row("GET", "/welcome")]);
  });

  it("returns app rows whose id is absent from the baseline", () => {
    const app = [row("GET", "/"), row("GET", "/health"), row("POST", "/users")];
    const baseline = [row("GET", "/"), row("GET", "/health")];
    assert.deepEqual(diffRoutes(app, baseline), [row("POST", "/users")]);
  });

  it("is a presence diff, not a deep-equality diff — an unchanged id never appears even if other fields differ", () => {
    const app = [{ ...row("GET", "/health"), middleware: 3, action: "healthCheck" }];
    const baseline = [row("GET", "/health")];
    assert.deepEqual(diffRoutes(app, baseline), []);
  });

  it("returns everything when the baseline is empty", () => {
    const app = [row("GET", "/a"), row("GET", "/b")];
    assert.deepEqual(diffRoutes(app, []), app);
  });

  it("returns nothing when the app has no routes at all", () => {
    assert.deepEqual(diffRoutes([], [row("GET", "/a")]), []);
  });
});

describe("substituteRouteParams", () => {
  it("replaces a single required param segment", () => {
    assert.equal(substituteRouteParams("/users/:id"), "/users/1");
  });

  it("replaces multiple param segments", () => {
    assert.equal(substituteRouteParams("/users/:userId/posts/:postId"), "/users/1/posts/1");
  });

  it("replaces an optional param segment (trailing ?)", () => {
    assert.equal(substituteRouteParams("/posts/:slug?"), "/posts/1");
  });

  it("leaves a path with no params untouched", () => {
    assert.equal(substituteRouteParams("/health"), "/health");
  });

  it("never collapses adjacent segments — the placeholder is never empty", () => {
    const result = substituteRouteParams("/a/:x/:y/b");
    assert.equal(result, "/a/1/1/b");
    assert.equal(result.includes("//"), false);
  });
});

describe("isRequestedStatus — the gate's 404/5xx-fail, 401/422-pass rule", () => {
  it("200 counts as requested", () => assert.equal(isRequestedStatus(200), true));
  it("401 counts as requested (a registered route answering)", () => assert.equal(isRequestedStatus(401), true));
  it("403 counts as requested", () => assert.equal(isRequestedStatus(403), true));
  it("422 counts as requested", () => assert.equal(isRequestedStatus(422), true));
  it("404 does NOT count as requested — the route is not actually reachable", () =>
    assert.equal(isRequestedStatus(404), false));
  it("500 does NOT count as requested — the route blew up", () => assert.equal(isRequestedStatus(500), false));
  it("503 does NOT count as requested", () => assert.equal(isRequestedStatus(503), false));
  it("rejects a non-numeric status defensively", () => assert.equal(isRequestedStatus(undefined as unknown as number), false));
});

describe("diffProjectCommands", () => {
  it("returns app-only commands whose source is 'project'", () => {
    const app = {
      commands: {
        "make:foo": { source: "project" as const },
        "routes": { source: "framework" as const },
      },
    };
    const baseline = { commands: { routes: { source: "framework" as const } } };
    assert.deepEqual(diffProjectCommands(app, baseline), ["make:foo"]);
  });

  it("never surfaces a framework or plugin command as introduced", () => {
    const app = {
      commands: {
        "vendor:sync": { source: "plugin" as const },
        "doctor": { source: "framework" as const },
      },
    };
    assert.deepEqual(diffProjectCommands(app, undefined), []);
  });

  it("returns an empty array when both sides are undefined (no commands.json at all)", () => {
    assert.deepEqual(diffProjectCommands(undefined, undefined), []);
  });

  it("excludes a project command that already existed in the baseline", () => {
    const shared = { commands: { "make:foo": { source: "project" as const } } };
    assert.deepEqual(diffProjectCommands(shared, shared), []);
  });
});

describe("detectHasWeb", () => {
  it("is true only when both the dependency and the scaffolded entry files agree", () => {
    assert.equal(detectHasWeb({ dependencies: { "@warlock.js/web": "^5.0.0" } }, true), true);
  });

  it("THROWS when the dependency is present but no entry files were found, rather than silently reporting no web", () => {
    // This spec previously asserted `false` here, and that assertion is what
    // let the real defect ship: the page check looked for
    // `src/web/home.page.tsx` while `warlock add web` writes
    // `src/web/index.page.tsx`, so hasWeb was false for EVERY web-bearing row,
    // the gate returned early at `if (!certificate.hasWeb) return;`, and the
    // browser oracle never ran once — while the rows reported clean passes.
    //
    // A false here may now only mean "this app has no web stack", never "this
    // oracle could not find it". The disagreement is the alarm.
    assert.throws(
      () => detectHasWeb({ dependencies: { "@warlock.js/web": "^5.0.0" } }, false),
      /no web entry files were found/,
    );
  });

  it("is false when the entry files exist but the dependency does not", () => {
    assert.equal(detectHasWeb({ dependencies: {} }, true), false);
  });

  it("is false for a plain app with neither signal", () => {
    assert.equal(detectHasWeb({ dependencies: {} }, false), false);
  });

  it("tolerates a missing dependencies object", () => {
    assert.equal(detectHasWeb({}, true), false);
  });
});

describe("assembleCertificate", () => {
  it("assembles exactly the schema the gate's parseRuntimeCertificate expects", () => {
    const certificate = assembleCertificate({
      appRoot: "/app",
      baselineRoot: "/baseline",
      features: ["auth", "cache"],
      typecheckPassed: true,
      development: { booted: true, ready: true, cleanExit: true },
      production: { booted: true, ready: true, cleanExit: true },
      introducedRoutes: [{ id: "GET /widgets", developmentRequested: true, productionRequested: true }],
      introducedCommands: [],
      hasWeb: false,
    });

    assert.deepEqual(certificate, {
      schemaVersion: 1,
      appRoot: "/app",
      baselineRoot: "/baseline",
      features: ["auth", "cache"],
      inventoryComplete: true,
      typecheckPassed: true,
      development: { booted: true, ready: true, cleanExit: true },
      production: { booted: true, ready: true, cleanExit: true },
      introducedRoutes: [{ id: "GET /widgets", developmentRequested: true, productionRequested: true }],
      introducedCommands: [],
      hasWeb: false,
    });
  });

  it("preserves feature order exactly (order-sensitive per the gate contract)", () => {
    const certificate = assembleCertificate({
      appRoot: "/app",
      baselineRoot: "/baseline",
      features: ["cache", "auth"],
      typecheckPassed: true,
      development: { booted: true, ready: true, cleanExit: true },
      production: { booted: true, ready: true, cleanExit: true },
      introducedRoutes: [],
      introducedCommands: [],
      hasWeb: true,
    });
    assert.deepEqual(certificate.features, ["cache", "auth"]);
  });
});

describe("WARLOCK_GENERATED_OUTPUT_ORACLE — real child-process argument validation", () => {
  let workspace: string;

  before(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "generated-output-oracle-spec-"));
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("fails with no stdout certificate when --app-root does not exist", async () => {
    const missing = path.join(workspace, "does-not-exist-app");
    const baseline = path.join(workspace, "baseline");
    await import("node:fs/promises").then(fs => fs.mkdir(baseline, { recursive: true }));

    const result = await run(
      [
        "--app-root",
        missing,
        "--baseline-root",
        baseline,
        "--features-json",
        "[]",
        "--candidate-version",
        "1.0.0",
        "--format",
        "json",
      ],
      workspace,
    );

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /does not exist/);
  });

  it("fails on a malformed --features-json before touching the filesystem", async () => {
    const result = await run(
      [
        "--app-root",
        workspace,
        "--baseline-root",
        workspace,
        "--features-json",
        "not-json",
        "--candidate-version",
        "1.0.0",
        "--format",
        "json",
      ],
      workspace,
    );

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /not valid JSON/);
  });

  it("fails on an inexact --candidate-version", async () => {
    const result = await run(
      [
        "--app-root",
        workspace,
        "--baseline-root",
        workspace,
        "--features-json",
        "[]",
        "--candidate-version",
        "not-a-version",
        "--format",
        "json",
      ],
      workspace,
    );

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /exact semver/);
  });
});
