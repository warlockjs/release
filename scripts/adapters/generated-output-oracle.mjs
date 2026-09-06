#!/usr/bin/env node
/**
 * WARLOCK_GENERATED_OUTPUT_ORACLE — adapter 2 of 3 for the zero-edit
 * generator gate (`builder/scripts/zero-edit-generator-gate.ts`).
 *
 * Invoked by the gate as a plain child process, once per feature-matrix row
 * (`zero-edit-generator-gate.ts:253-259`, args built at `:487-489`):
 *
 *   node generated-output-oracle.mjs --app-root <app> --baseline-root <baseline> \
 *     --features-json <json array> --candidate-version <semver> --format json
 *
 * It prints exactly one JSON "runtime certificate" line to stdout on success
 * (schema below) and exits 0 only when every assertion in it genuinely held.
 * On ANY failure it prints nothing to stdout, writes a message naming what
 * failed to stderr, and exits non-zero. It never invents a `true`.
 *
 * ## What the certificate proves, and how
 *
 * 1. **Typecheck** — `<app>/node_modules/typescript/bin/tsc --noEmit`, run
 *    directly under `node` (never through the `node_modules/.bin/tsc` shell
 *    shim — that is not JavaScript and cannot be spawned as one), cwd `<app>`.
 *
 * 2. **Route inventory** — `warlock routes --json` run against both the app
 *    and the baseline (`node <root>/node_modules/@warlock.js/core/bin/warlock.js
 *    routes --json`). `routes.command.ts` preloads `{config, env, bootstrap}`
 *    with NO `connectors` key, and `cli-commands.manager.ts:739-812` only
 *    starts connectors `if (preloaders.connectors)` — so this seam runs with
 *    zero external services, safe even when the row includes `herald`. Row
 *    shape is `{method, path, name, action, middleware, source}`
 *    (`core/src/cli/commands/routes/route-row.ts:10-28`); this oracle defines
 *    a route's identity as `` `${method} ${path}` `` and takes the SET
 *    DIFFERENCE of app rows minus baseline rows as "introduced" routes.
 *
 *    **KNOWN LIMITATION, DELIBERATE, NOT PAPERED OVER:** the `web` feature's
 *    SSR page route (`GET /`) is registered inside `WebConnector`'s boot
 *    (`web/src/server/web-connector.ts:396,536,699,742`), which `routes
 *    --json` never reaches (that command never starts connectors). SSR page
 *    routes are therefore INVISIBLE to this seam and will never appear in
 *    `introducedRoutes` here — they can only be proved by the browser oracle
 *    (adapter 3), which drives a real browser against the running app. A row
 *    that only adds page routes (no new API route) will legitimately produce
 *    an empty `introducedRoutes` from this oracle; that is correct, not a
 *    bug, and `hasWeb` is what tells the gate to also run the browser oracle.
 *
 * 3. **Command inventory** — `.warlock/commands.json`, entries with
 *    `source === "project"` (shape at `core/src/manifest/manifest-manager.ts:
 *    20-30`). Populated by running `node <core>/bin/warlock.js --warm-cache`
 *    (flag at `core/src/cli/cli-commands.utils.ts:310`, handler
 *    `cli-commands.manager.ts:257-260`, scan at `:385-399`) in each root, then
 *    diffing the `source === "project"` keys app-vs-baseline.
 *
 *    **MEASURED FACT, STATED PLAINLY:** as of this writing no feature in
 *    `featuresMap` scaffolds an app-level command, so `introducedCommands` is
 *    expected to be an EMPTY array for every row today. That is a real
 *    inventory returning a real empty result — not a skipped check — and it
 *    will catch the first feature that ever adds one. This oracle never
 *    fabricates a command entry to fill this list.
 *
 *    For any command this diff DOES surface, "executed" is defined as: `node
 *    <core>/bin/warlock.js <name> --help` (a universally-safe invocation that
 *    every `command()`-built CLI command accepts without side effects) exits
 *    0 in the app. This path is untested against a real project command
 *    because none exists in the catalog today; the definition is recorded
 *    here so it travels with the assertion the day one appears.
 *
 * 4. **`hasWeb`** — derived from the GENERATED APP, not from the feature list
 *    string-matching "web": true only when `@warlock.js/web` appears in the
 *    app's own `package.json` dependencies AND the two files `warlock add web`
 *    scaffolds — `src/web/root.tsx` and `src/web/home.page.tsx` — both exist
 *    on disk. Either signal alone is not trusted (a stale dependency with no
 *    scaffolded entry, or vice versa, would be a lie).
 *
 * 5. **"Requested"** (`introducedRoutes[].developmentRequested` /
 *    `.productionRequested`) means: a real HTTP request was sent to the
 *    running server for that route (each `:param` segment substituted with a
 *    deterministic placeholder, see {@link substituteRouteParams}), a
 *    response was received, and `status !== 404 && status < 500`. A
 *    401/403/422 is a REGISTERED route answering — that counts as requested.
 *    A 404 means the route is not actually reachable; a 5xx means it blew up
 *    handling the request. Both fail the assertion. See
 *    {@link isRequestedStatus}.
 *
 * 6. **`herald`** is the one feature that cannot boot without an external
 *    service (RabbitMQ on localhost:5672 — `core/src/connectors/
 *    herald-connector.ts:23-45` logs fatal and rethrows on connect failure,
 *    `herald/src/utils/connect-to-broker.ts:97-103` rethrows). This oracle
 *    does NOT special-case, skip, or fake a boot for it: if a row includes
 *    `herald` and no broker is reachable, `development.booted` /
 *    `production.booted` genuinely come back `false`, the oracle fails
 *    honestly, and the reported error names the boot failure.
 *
 * ## Lifecycle reuse
 *
 * Dev boot/stop/port-release, `warlock build`, and `warlock start` follow the
 * shape of `web/tests/acceptance/published-react-gate.mjs:263-327` (spawn,
 * poll for readiness, stop, wait for the port to free, build, start with
 * explicit `NODE_ENV`/`HTTP_PORT`). Unlike that gate, this oracle has no fixed
 * HMR marker to poll for (the generated app under test is arbitrary, not a
 * fixture this repo wrote) — see {@link waitForServerReady} for the readiness
 * definition used instead.
 *
 * `cleanExit` means: this oracle asked the server to stop (SIGTERM on POSIX,
 * `taskkill /t /f` on Windows, matching `published-react-gate.mjs:1008-1036`)
 * and the process tree exited before the process needed to be force-killed
 * AND before the shutdown timeout elapsed. A process still alive after the
 * timeout, or one this oracle had to SIGKILL, is NOT a clean exit.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { assertExistingDirectory, parseOracleArguments } from "./oracle-arguments.mjs";

const execFileAsync = promisify(execFile);

const AMBIENT_ENV_KEYS_TO_CLEAR = ["HTTP_PORT", "NODE_ENV", "BASE_URL", "APP_NAME"];
const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 15_000;
const PORT_RELEASE_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Build a route's identity exactly as the gate contract defines it: verb plus
 * literal path, unrelated to filters, names, or source files. Used both to
 * diff two inventories and to label `introducedRoutes[].id`.
 *
 * @param method Uppercased HTTP verb from a `RouteRow`.
 * @param routePath Full request path from a `RouteRow`.
 * @returns The route's identity string.
 */
export function routeId(method, routePath) {
  return `${method} ${routePath}`;
}

/**
 * Set-difference two route inventories by {@link routeId}. A route counts as
 * "introduced" only when its id is absent from the baseline entirely — this
 * is a presence diff, not a deep-equality diff, because a route whose
 * middleware count or action label changed while staying registered was not
 * introduced by the feature under test.
 *
 * @param appRows `RouteRow[]` from the generated app's `routes --json`.
 * @param baselineRows `RouteRow[]` from the baseline's `routes --json`.
 * @returns The app-only rows, in app order.
 */
export function diffRoutes(appRows, baselineRows) {
  const baselineIds = new Set(baselineRows.map(row => routeId(row.method, row.path)));
  return appRows.filter(row => !baselineIds.has(routeId(row.method, row.path)));
}

/**
 * Replace every `:param` (optionally `?`-suffixed for an optional segment)
 * path segment with a deterministic literal so an introduced parameterized
 * route can actually be requested. The placeholder is a plain literal, never
 * empty, so it can never collapse two path segments together.
 *
 * @param routePath A route path such as `/users/:id` or `/posts/:slug?`.
 * @returns The path with every param segment replaced by `1`.
 */
export function substituteRouteParams(routePath) {
  return routePath.replace(/:[A-Za-z0-9_]+\??/g, "1");
}

/**
 * The gate's "requested" rule (assertion contract, point 5 in this file's
 * header JSDoc): a 404 proves the route is not actually reachable, a 5xx
 * proves it blew up handling the request, and everything else — including
 * 401/403/422 — proves a registered route genuinely answered.
 *
 * @param status HTTP status code received for the request.
 * @returns Whether the request counts as "requested" for the certificate.
 */
export function isRequestedStatus(status) {
  return typeof status === "number" && status !== 404 && status < 500;
}

/**
 * Diff two `.warlock/commands.json` documents down to the app-only
 * `source === "project"` command names — the population `warlock add`
 * feature scaffolds are expected to touch (framework/plugin commands ship
 * with Core itself and can never be "introduced" by a generator feature).
 *
 * @param appCommandsJson Parsed `commands.json` from the generated app, or `undefined` if absent.
 * @param baselineCommandsJson Parsed `commands.json` from the baseline, or `undefined` if absent.
 * @returns The introduced project-command names, in app object key order.
 */
export function diffProjectCommands(appCommandsJson, baselineCommandsJson) {
  const appCommands = appCommandsJson?.commands ?? {};
  const baselineCommands = baselineCommandsJson?.commands ?? {};
  return Object.keys(appCommands).filter(
    name => appCommands[name]?.source === "project" && baselineCommands[name] === undefined,
  );
}

/**
 * `hasWeb` per the gate contract's point 3: trust neither signal alone. The
 * dependency can be stale (removed from disk, left in package.json) and the
 * files can exist without the dependency in a hand-edited fixture — this
 * oracle only ever sees generator output, so both must agree.
 *
 * @param packageJson Parsed `package.json` of the generated app.
 * @param entryFilesExist Whether both `src/web/root.tsx` and `src/web/home.page.tsx` exist.
 * @returns Whether the generated app genuinely has the web stack.
 */
export function detectHasWeb(packageJson, entryFilesExist) {
  const hasDependency = Boolean(packageJson?.dependencies?.["@warlock.js/web"]);
  return hasDependency && entryFilesExist === true;
}

/**
 * Assemble the runtime certificate the gate's `parseRuntimeCertificate`
 * parses (`zero-edit-generator-gate.ts:451-468`). Pure and side-effect free
 * so the shape can be asserted in isolation from every I/O step above it.
 *
 * @param parts Every measured field the certificate reports.
 * @returns The certificate object, ready for `JSON.stringify`.
 */
export function assembleCertificate({
  appRoot,
  baselineRoot,
  features,
  typecheckPassed,
  development,
  production,
  introducedRoutes,
  introducedCommands,
  hasWeb,
}) {
  return {
    schemaVersion: 1,
    appRoot,
    baselineRoot,
    features,
    inventoryComplete: true,
    typecheckPassed,
    development,
    production,
    introducedRoutes,
    introducedCommands,
    hasWeb,
  };
}

async function main() {
  const options = parseOracleArguments(process.argv.slice(2));
  await assertExistingDirectory("--app-root", options.appRoot);
  await assertExistingDirectory("--baseline-root", options.baselineRoot);

  const appPackageJson = await readJson(path.join(options.appRoot, "package.json"));
  const hasWeb = detectHasWeb(appPackageJson, webEntryFilesExist(options.appRoot));

  await runTypecheck(options.appRoot);

  const appRoutes = await routesJson(options.appRoot);
  const baselineRoutes = await routesJson(options.baselineRoot);
  const introducedRouteRows = diffRoutes(appRoutes, baselineRoutes);

  const appCommandsJson = await warmAndReadCommands(options.appRoot);
  const baselineCommandsJson = await warmAndReadCommands(options.baselineRoot);
  const introducedCommandNames = diffProjectCommands(appCommandsJson, baselineCommandsJson);
  const introducedCommands = [];
  for (const name of introducedCommandNames) {
    introducedCommands.push({
      id: name,
      executed: await commandExecutes(options.appRoot, name),
    });
  }

  const development = await exercisePhase({
    appRoot: options.appRoot,
    phase: "development",
    introducedRouteRows,
  });
  const production = await exerciseProductionPhase({
    appRoot: options.appRoot,
    introducedRouteRows,
  });

  const introducedRoutes = introducedRouteRows.map(row => ({
    id: routeId(row.method, row.path),
    developmentRequested: development.requested.get(routeId(row.method, row.path)) === true,
    productionRequested: production.requested.get(routeId(row.method, row.path)) === true,
  }));

  const certificate = assembleCertificate({
    appRoot: options.appRoot,
    baselineRoot: options.baselineRoot,
    features: options.features,
    typecheckPassed: true,
    development: development.phase,
    production: production.phase,
    introducedRoutes,
    introducedCommands,
    hasWeb,
  });

  process.stdout.write(`${JSON.stringify(certificate)}\n`);
}

/** Read and JSON.parse a file, failing loudly with the path on any problem. */
async function readJson(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${filePath}: ${String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${String(error)}`);
  }
}

/** Read a JSON file if it exists, or return `undefined` when it does not. */
async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return undefined;
  return readJson(filePath);
}

function webEntryFilesExist(appRoot) {
  return (
    existsSync(path.join(appRoot, "src", "web", "root.tsx")) &&
    existsSync(path.join(appRoot, "src", "web", "home.page.tsx"))
  );
}

function coreBinPath(root) {
  return path.join(root, "node_modules", "@warlock.js", "core", "bin", "warlock.js");
}

/** A clean child environment: the ambient shell's port/env/base-url/app-name never leaks in. */
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of AMBIENT_ENV_KEYS_TO_CLEAR) delete env[key];
  return { ...env, ...overrides };
}

async function runTypecheck(appRoot) {
  const tsc = path.join(appRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    throw new Error(`Generated app has no installed TypeScript to typecheck with: ${tsc}`);
  }
  try {
    await execFileAsync(process.execPath, [tsc, "--noEmit"], {
      cwd: appRoot,
      env: cleanEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Generated app failed to typecheck: ${error.stdout || ""}${error.stderr || String(error)}`,
    );
  }
}

async function routesJson(root) {
  const bin = coreBinPath(root);
  if (!existsSync(bin)) {
    throw new Error(`Cannot locate installed Core CLI to run \`routes --json\`: ${bin}`);
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [bin, "routes", "--json"], {
      cwd: root,
      env: cleanEnv(),
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`\`warlock routes --json\` failed in ${root}: ${error.stderr || String(error)}`);
  }
  try {
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error("expected a JSON array");
    return rows;
  } catch (error) {
    // Quote what the seam actually printed. When this first fired, the cause
    // was the CLI's own success banner sharing stdout with the payload — and
    // the parser error alone ("unexpected non-whitespace character") named
    // neither the contaminant nor the command that emitted it.
    throw new Error(
      `\`warlock routes --json\` in ${root} did not print a JSON array: ${String(error)}\n` +
        `--- raw stdout (${stdout.length} chars) ---\n${stdout.slice(0, 2000)}\n--- end raw stdout ---`,
    );
  }
}

async function warmAndReadCommands(root) {
  const bin = coreBinPath(root);
  if (!existsSync(bin)) {
    throw new Error(`Cannot locate installed Core CLI to run \`--warm-cache\`: ${bin}`);
  }
  try {
    await execFileAsync(process.execPath, [bin, "--warm-cache"], {
      cwd: root,
      env: cleanEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`\`warlock --warm-cache\` failed in ${root}: ${error.stderr || String(error)}`);
  }
  return readJsonIfExists(path.join(root, ".warlock", "commands.json"));
}

async function commandExecutes(appRoot, name) {
  const bin = coreBinPath(appRoot);
  try {
    await execFileAsync(process.execPath, [bin, name, "--help"], {
      cwd: appRoot,
      env: cleanEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function bindAndReleasePort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(error => (error ? reject(error) : resolve())));
  });
}

async function waitForPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await bindAndReleasePort(port);
      return true;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`HTTP_PORT ${port} was not released: ${String(lastError)}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Ready" for an arbitrary generated app (unlike the fixture
 * `published-react-gate.mjs` polls for, this oracle has no HMR marker baked
 * into a page it wrote) means: the server accepted a real TCP connection and
 * answered an HTTP request to `/` with SOME status code below 500. A refused
 * connection means it has not bound the port yet; a 5xx on the very first
 * request means it booted into a broken state, which is not "ready".
 */
async function waitForServerReady(baseUrl, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode} before becoming ready.`);
    }
    try {
      const response = await fetchWithTimeout(`${baseUrl}/`, {}, REQUEST_TIMEOUT_MS);
      if (response.status < 500) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Server did not become ready at ${baseUrl}: ${String(lastError)}`);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Stop a spawned server and report whether it terminated cleanly (see header JSDoc). */
async function stopServerCleanly(child) {
  if (!child || child.exitCode !== null) return true;
  const exited = new Promise(resolve => child.once("exit", resolve));
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        timeout: STOP_TIMEOUT_MS,
      });
    } catch {
      // fallthrough to the alive check below
    }
  } else {
    child.kill("SIGTERM");
    const stoppedGracefully = await Promise.race([
      exited.then(() => true),
      delay(STOP_TIMEOUT_MS / 2).then(() => false),
    ]);
    if (!stoppedGracefully && child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.race([exited, delay(STOP_TIMEOUT_MS / 2)]);
  return !processIsAlive(child.pid);
}

/** Issue one request per introduced route and record whether it counts as "requested" (point 5). */
async function requestIntroducedRoutes(baseUrl, introducedRouteRows) {
  const requested = new Map();
  for (const row of introducedRouteRows) {
    const method = row.method === "ALL" || row.method === "HEAD" ? "GET" : row.method;
    const url = `${baseUrl}${substituteRouteParams(row.path)}`;
    try {
      const response = await fetchWithTimeout(url, { method }, REQUEST_TIMEOUT_MS);
      requested.set(routeId(row.method, row.path), isRequestedStatus(response.status));
    } catch {
      requested.set(routeId(row.method, row.path), false);
    }
  }
  return requested;
}

async function exercisePhase({ appRoot, introducedRouteRows }) {
  const bin = coreBinPath(appRoot);
  const port = await reserveEphemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [bin, "dev"], {
    cwd: appRoot,
    env: cleanEnv({ NODE_ENV: "development", HTTP_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr?.on("data", chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  let booted = true;
  let ready = false;
  let requested = new Map();
  try {
    await waitForServerReady(baseUrl, child, READY_TIMEOUT_MS);
    ready = true;
    requested = await requestIntroducedRoutes(baseUrl, introducedRouteRows);
  } catch (error) {
    booted = child.exitCode === null || child.exitCode === 0;
    const cleanExit = await stopServerCleanly(child);
    await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS).catch(() => undefined);
    throw new Error(
      `Development boot for ${appRoot} did not become ready: ${String(error)}\n${stderrTail}\n` +
        `(booted=${booted} cleanExit=${cleanExit})`,
    );
  }

  const cleanExit = await stopServerCleanly(child);
  await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS);

  return { phase: { booted, ready, cleanExit }, requested };
}

async function exerciseProductionPhase({ appRoot, introducedRouteRows }) {
  const bin = coreBinPath(appRoot);
  try {
    await execFileAsync(process.execPath, [bin, "build"], {
      cwd: appRoot,
      env: cleanEnv({ NODE_ENV: "production" }),
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`\`warlock build\` failed for ${appRoot}: ${error.stderr || String(error)}`);
  }

  const port = await reserveEphemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [bin, "start"], {
    cwd: appRoot,
    env: cleanEnv({ NODE_ENV: "production", HTTP_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr?.on("data", chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  let booted = true;
  let ready = false;
  let requested = new Map();
  try {
    await waitForServerReady(baseUrl, child, READY_TIMEOUT_MS);
    ready = true;
    requested = await requestIntroducedRoutes(baseUrl, introducedRouteRows);
  } catch (error) {
    booted = child.exitCode === null || child.exitCode === 0;
    const cleanExit = await stopServerCleanly(child);
    await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS).catch(() => undefined);
    throw new Error(
      `Production boot for ${appRoot} did not become ready: ${String(error)}\n${stderrTail}\n` +
        `(booted=${booted} cleanExit=${cleanExit})`,
    );
  }

  const cleanExit = await stopServerCleanly(child);
  await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS);

  return { phase: { booted, ready, cleanExit }, requested };
}

// Only run as a CLI when invoked directly (`node generated-output-oracle.mjs ...`),
// never when a test suite imports this module by path to reach its pure,
// testable exports (route diffing, param substitution, the requested/status
// rule, `hasWeb` detection, certificate assembly) — importing it must never
// have the side effect of parsing `process.argv` and spawning child processes.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
