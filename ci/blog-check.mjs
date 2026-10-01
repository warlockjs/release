// The release's blog check: installs the Warlock.js family into the blog test
// app, then proves it end to end on a GitHub Actions ubuntu runner.
//
//   node ci/blog-check.mjs          (from builder/, after the family gate)
//
// Steps, in order, all inside $BLOG_DIR:
//   1. point every @warlock.js/* at the gate tarballs (MODE=tarballs) or the
//      exact published version (MODE=registry), add @warlock.js/devtools, and
//      install; then prove one version and one physical @warlock.js/core
//   2. write a CI .env (dummy mail/storage/auth values, Postgres from the service)
//   3. wire devtools the way a user does: `warlock add devtools --no-install`
//   4. `warlock generate.typings`, then `tsc --noEmit`
//   5. recreate the database empty, then `pnpm run migrate`, `pnpm run seed`
//   6. `warlock dev`: a /posts request shows up at /__warlock/api with its
//      phases and queries, and EXPLAIN works on one of its SELECTs
//   7. `pnpm run build` + `warlock start`: ready banner, browser smoke,
//      /__warlock is a 404 in production
//   8. deploy in parts: `--role=worker` binds no port, `--role=api` serves
//      /api/posts and 404s a page
//
// Inputs (env):
//   BLOG_DIR, WARLOCK_VERSION, MODE (tarballs | registry), TARBALL_DIR (tarballs),
//   PLAYWRIGHT_MODULE (absolute path to @playwright/test/index.mjs), EVIDENCE_PATH,
//   DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME (Postgres service defaults).
//
// It rewrites package.json, the lockfile and .env, so it refuses to run outside
// GitHub Actions unless BLOG_CHECK_DISPOSABLE=1 says the checkout is scratch.
// Server logs land next to the evidence file, in blog-check-logs/.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const TAG = "[blog-check]";

const HOST = "127.0.0.1";
const HTTP_PORT = 2041;
const BASE_URL = `http://${HOST}:${HTTP_PORT}`;

const FAMILY_SIZE = 31;
const DEVTOOLS_PACKAGE = "@warlock.js/devtools";
const DEVTOOLS_PATH = "/__warlock";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const TIMEOUTS = {
  install: 20 * MINUTE,
  command: 5 * MINUTE,
  build: 15 * MINUTE,
  devBoot: 4 * MINUTE,
  prodBoot: 3 * MINUTE,
  firstDevPage: 3 * MINUTE,
  serverLifetime: 15 * MINUTE,
  stopGrace: 15 * SECOND,
  portRelease: 20 * SECOND,
};

// Inherited values that would beat the .env file: core loads env with
// `precedence: "process-wins"` (core/src/utils/load-environment.ts).
const SCRUBBED_ENV = [
  "NODE_ENV",
  "HTTP_PORT",
  "HTTP_HOST",
  "APP_NAME",
  "BASE_URL",
  "PUBLIC_APP_URL",
  "WEB_ORIGINS",
  "WARLOCK_ROLES",
  "WARLOCK_SITES",
  "WARLOCK_DEV_WORKER",
  "WARLOCK_BOOT_SIGNAL",
];

// Env files that would replace or merge into .env (@mongez/dotenv resolution).
const SHADOWING_ENV_FILES = [".env.shared", ".env.development", ".env.production", ".env.test"];

const ENV_MARKER = "# blog-check CI env (generated; dummy values only)";

// Page phases web/core report through the tracing hooks:
// web/src/server/execute-page-request.ts:274 (page.middleware), :839 (loader),
// web/src/server/render-page.ts:1320 (render.shell).
const REQUIRED_DEV_PHASES = ["page.middleware", "loader", "render.shell"];

// Literal log lines, from source.
const LINES = {
  // devtools/src/devtools-connector.ts:111
  devtoolsReady: `devtools ready at ${DEVTOOLS_PATH}`,
  // devtools/src/devtools-connector.ts:62-66 (only reachable if something registers
  // the connector outside development; `warlock start` never does)
  devtoolsRefusal: "@warlock.js/devtools only runs in development; it is not mounted",
  // core/src/production/production-supervisor.ts:163
  workerReady: "worker ready — roles: worker",
  // core/src/connectors/http-connector.ts:170
  httpNotStarted: "http: not started (role: worker)",
  // web/src/server/web-connector.ts:405
  pagesNotInstalled: "web: pages not installed (role: api)",
  // scheduler/src/scheduler.ts:283
  schedulerNotStarted: "scheduler: not started (role: api)",
  // core/src/generations/add-command.action.ts:155
  alreadyInstalled: `${DEVTOOLS_PACKAGE} is already installed, skipping...`,
};

// Ported from the blog's temp/blog-smoke-v524-prod.mjs.
const MISSING_PAGE = "/public-smoke-missing-ci";
const SMOKE_PAGES = [
  "/",
  "/posts",
  "/contact",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  MISSING_PAGE,
];
const GUARDED_PAGES = ["/account", "/admin"];
const SMOKE_FORMS = [
  ["/contact", "#contact-form"],
  ["/login", "#login-form"],
  ["/signup", "#signup-form"],
  ["/forgot-password", "#forgot-form"],
  ["/reset-password", "#reset-form"],
];
const MOBILE_WIDTH = 375;

const liveProcesses = new Set();

// ─── small helpers ───────────────────────────────────────────────────────────

function log(message) {
  console.log(`${TAG} ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tail(text, lines = 60) {
  return stripAnsi(text).split("\n").slice(-lines).join("\n");
}

function toPosix(file) {
  return file.split(path.sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ─── inputs ──────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`missing required env ${name}`);
  }

  return value;
}

function requireAbsoluteFile(name) {
  const file = requireEnv(name);

  if (!path.isAbsolute(file) || !fs.existsSync(file)) {
    throw new Error(`${name} must be an absolute path to an existing file, got "${file}"`);
  }

  return file;
}

function readInputs() {
  const mode = requireEnv("MODE");

  if (mode !== "tarballs" && mode !== "registry") {
    throw new Error(`MODE must be "tarballs" or "registry", got "${mode}"`);
  }

  const version = requireEnv("WARLOCK_VERSION");

  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`WARLOCK_VERSION must be an exact version like 5.25.0, got "${version}"`);
  }

  const blogDir = path.resolve(requireEnv("BLOG_DIR"));

  if (!fs.existsSync(path.join(blogDir, "package.json"))) {
    throw new Error(`BLOG_DIR has no package.json: ${blogDir}`);
  }

  let tarballDir;

  if (mode === "tarballs") {
    tarballDir = requireEnv("TARBALL_DIR");

    if (!path.isAbsolute(tarballDir) || !fs.existsSync(tarballDir)) {
      throw new Error(`TARBALL_DIR must be an absolute, existing directory, got "${tarballDir}"`);
    }
  }

  return {
    mode,
    version,
    blogDir,
    tarballDir,
    playwrightModule: requireAbsoluteFile("PLAYWRIGHT_MODULE"),
    db: {
      host: process.env.DB_HOST || "127.0.0.1",
      port: process.env.DB_PORT || "5432",
      username: process.env.DB_USERNAME || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      name: process.env.DB_NAME || "warlock_blog_ci",
    },
  };
}

function assertDisposableRunner() {
  if (process.platform === "win32") {
    throw new Error("blog-check runs on Linux only (it stops servers by process group)");
  }

  if (process.env.GITHUB_ACTIONS !== "true" && process.env.BLOG_CHECK_DISPOSABLE !== "1") {
    throw new Error(
      "refusing to rewrite a blog checkout outside GitHub Actions; set BLOG_CHECK_DISPOSABLE=1 for a scratch copy",
    );
  }
}

// ─── processes ───────────────────────────────────────────────────────────────

function childEnv() {
  const env = { ...process.env };

  for (const key of SCRUBBED_ENV) {
    delete env[key];
  }

  return env;
}

/**
 * Spawns `command` in its own process group, teeing stdout+stderr into a log
 * file and an in-memory buffer. A watchdog kills the group at `timeoutMs`.
 */
function spawnLogged(label, command, args, { cwd, logsDir, timeoutMs, env = {} }) {
  const logFile = path.join(logsDir, `${label}.log`);
  const logStream = fs.createWriteStream(logFile);
  const child = spawn(command, args, {
    cwd,
    env: { ...childEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let output = "";
  let timedOut = false;

  const collect = (chunk) => {
    output += chunk.toString();
    logStream.write(chunk);
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const handle = {
    label,
    child,
    logFile,
    output: () => stripAnsi(output),
    rawOutput: () => output,
    hasExited: false,
    timedOut: () => timedOut,
  };

  handle.exited = new Promise((resolve) => {
    child.on("error", (error) => {
      output += `\n${TAG} spawn error: ${error.message}\n`;
    });

    child.on("close", (code, signal) => {
      handle.hasExited = true;
      liveProcesses.delete(handle);
      clearTimeout(watchdog);
      logStream.end();
      resolve({ code, signal });
    });
  });

  const watchdog = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGKILL");
  }, timeoutMs);

  liveProcesses.add(handle);

  return handle;
}

function killGroup(child, signal) {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function stopProcess(handle) {
  if (!handle.hasExited) {
    killGroup(handle.child, "SIGTERM");

    const stopped = await Promise.race([
      handle.exited.then(() => true),
      delay(TIMEOUTS.stopGrace).then(() => false),
    ]);

    if (!stopped) {
      log(`${handle.label} ignored SIGTERM for ${TIMEOUTS.stopGrace}ms; sending SIGKILL`);
    }
  }

  // Sweep the group even after the leader exits: `warlock dev` and
  // `warlock start` are supervisors with a child of their own.
  killGroup(handle.child, "SIGKILL");
  await Promise.race([handle.exited, delay(5 * SECOND)]);
}

/** Runs a command to completion; throws with the log tail on failure. */
async function runCommand(label, command, args, options) {
  log(`run ${label}: ${[command, ...args].map((arg) => toPosix(arg)).join(" ")}`);

  const handle = spawnLogged(label, command, args, options);
  const { code, signal } = await handle.exited;

  if (handle.timedOut()) {
    throw new Error(
      `${label} timed out after ${options.timeoutMs}ms (log: ${handle.logFile})\n${tail(handle.rawOutput())}`,
    );
  }

  if (code !== 0) {
    throw new Error(
      `${label} failed (code ${code}, signal ${signal}) (log: ${handle.logFile})\n${tail(handle.rawOutput())}`,
    );
  }

  return handle.output();
}

function warlockArgs(context, ...args) {
  return [context.warlockBin, ...args];
}

function runWarlock(context, label, args, timeoutMs = TIMEOUTS.command) {
  return runCommand(label, process.execPath, warlockArgs(context, ...args), {
    cwd: context.blogDir,
    logsDir: context.logsDir,
    timeoutMs,
  });
}

function runPnpm(context, label, args, timeoutMs = TIMEOUTS.command) {
  return runCommand(label, "pnpm", args, {
    cwd: context.blogDir,
    logsDir: context.logsDir,
    timeoutMs,
  });
}

function startWarlockServer(context, label, args) {
  log(`start ${label}: warlock ${args.join(" ")}`);

  return spawnLogged(label, process.execPath, warlockArgs(context, ...args), {
    cwd: context.blogDir,
    logsDir: context.logsDir,
    timeoutMs: TIMEOUTS.serverLifetime,
  });
}

// ─── waiting ─────────────────────────────────────────────────────────────────

function assertStillRunning(handle, waitingFor) {
  if (handle.hasExited) {
    throw new Error(
      `${handle.label} exited while waiting for ${waitingFor} (log: ${handle.logFile})\n${tail(handle.rawOutput())}`,
    );
  }
}

async function waitForOutput(handle, pattern, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = handle.output().match(pattern);

    if (match) {
      return match[0];
    }

    assertStillRunning(handle, what);
    await delay(500);
  }

  throw new Error(
    `${handle.label}: no ${what} within ${timeoutMs}ms (log: ${handle.logFile})\n${tail(handle.rawOutput())}`,
  );
}

async function httpRequest(url, { method = "GET", timeoutMs = 30 * SECOND } = {}) {
  const response = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

function parseJsonBody(result, what) {
  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(
      `${what}: expected JSON, got ${result.status} ${result.contentType} "${result.body.slice(0, 200)}"`,
    );
  }
}

async function getJson(url, what) {
  const result = await httpRequest(url);

  if (result.status !== 200) {
    throw new Error(`${what}: GET ${url} returned ${result.status}: ${JSON.stringify(result.body.slice(0, 300))}`);
  }

  return parseJsonBody(result, what);
}

async function waitForHttpOk(handle, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = "no attempt yet";

  while (Date.now() < deadline) {
    assertStillRunning(handle, `200 from ${url}`);

    try {
      const result = await httpRequest(url, { timeoutMs: 10 * SECOND });

      if (result.status === 200) {
        return result;
      }

      lastProblem = `status ${result.status}`;
    } catch (error) {
      lastProblem = errorMessage(error);
    }

    await delay(SECOND);
  }

  throw new Error(
    `${handle.label}: ${url} not 200 within ${timeoutMs}ms (last: ${lastProblem}) (log: ${handle.logFile})\n${tail(handle.rawOutput())}`,
  );
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });

    socket.setTimeout(SECOND);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPortFree(port) {
  const deadline = Date.now() + TIMEOUTS.portRelease;

  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) {
      return;
    }

    await delay(500);
  }

  throw new Error(`port ${port} is busy: still accepting connections after ${TIMEOUTS.portRelease}ms`);
}

/** Starts a server, runs `body` against it, and always stops it. */
async function withServer(context, label, args, body) {
  await waitForPortFree(HTTP_PORT);

  const server = startWarlockServer(context, label, args);

  try {
    return await body(server);
  } catch (error) {
    // A failed check against a live server is only diagnosable with what the
    // server said at the time.
    throw new Error(`${errorMessage(error)}
--- ${label} output (tail) ---
${tail(server.rawOutput())}`);
  } finally {
    await stopProcess(server);
    log(`stopped ${label}`);
  }
}

// ─── step 1: package source + install ────────────────────────────────────────

function packageNameFromTarball(file, version) {
  const base = file.slice(0, -`-${version}.tgz`.length);

  if (base === "create-warlock") {
    return "create-warlock";
  }

  if (base.startsWith("warlock.js-")) {
    return `@warlock.js/${base.slice("warlock.js-".length)}`;
  }

  throw new Error(`unexpected tarball name: ${file}`);
}

function readTarballSpecs(tarballDir, version) {
  const suffix = `-${version}.tgz`;
  const tarballs = fs.readdirSync(tarballDir).filter((file) => file.endsWith(".tgz"));
  const matching = tarballs.filter((file) => file.endsWith(suffix));

  if (tarballs.length !== FAMILY_SIZE || matching.length !== FAMILY_SIZE) {
    throw new Error(
      `expected exactly ${FAMILY_SIZE} *${suffix} tarballs in ${tarballDir}, found ${matching.length} matching of ${tarballs.length} .tgz`,
    );
  }

  const specs = {};

  for (const file of matching) {
    specs[packageNameFromTarball(file, version)] = `file:${toPosix(path.join(tarballDir, file))}`;
  }

  for (const required of ["@warlock.js/core", DEVTOOLS_PACKAGE]) {
    if (!specs[required]) {
      throw new Error(`no tarball for ${required} in ${tarballDir}`);
    }
  }

  return specs;
}

function rewritePackageJson(blogDir, specFor, overrides) {
  const file = path.join(blogDir, "package.json");
  const pkg = readJson(file);
  const rewritten = {};

  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith("@warlock.js/")) {
        pkg[field][name] = specFor(name);
        rewritten[name] = pkg[field][name];
      }
    }
  }

  if (pkg.dependencies?.[DEVTOOLS_PACKAGE]) {
    delete pkg.dependencies[DEVTOOLS_PACKAGE];
  }

  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [DEVTOOLS_PACKAGE]: specFor(DEVTOOLS_PACKAGE) };
  rewritten[DEVTOOLS_PACKAGE] = pkg.devDependencies[DEVTOOLS_PACKAGE];

  // pnpm 11 ignores package.json `pnpm.*` settings (pnpm CHANGELOG, "pnpm no
  // longer reads settings from the pnpm field"); kept because the brief asks
  // for it and pnpm 10 still reads it. pnpm-workspace.yaml carries the copy
  // that pnpm 11 obeys — see patchWorkspaceYaml.
  if (overrides) {
    pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides };
  }

  const hadPostinstall = Boolean(pkg.scripts?.postinstall);

  if (hadPostinstall) {
    delete pkg.scripts.postinstall;
  }

  writeJson(file, pkg);

  return { rewritten, removedPostinstall: hadPostinstall };
}

function ensureReleaseAgeExclude(lines) {
  const keyIndex = lines.findIndex((line) => /^minimumReleaseAgeExclude:/.test(line));

  if (keyIndex === -1) {
    return "no minimumReleaseAgeExclude list";
  }

  if (!/^minimumReleaseAgeExclude:\s*$/.test(lines[keyIndex])) {
    throw new Error("pnpm-workspace.yaml: minimumReleaseAgeExclude is not a block list; cannot extend it safely");
  }

  const entries = [];

  for (let index = keyIndex + 1; index < lines.length && /^\s*-\s/.test(lines[index]); index++) {
    entries.push(lines[index]);
  }

  const alreadyExcluded = entries.some(
    (entry) => entry.replace(/^\s*-\s*/, "").replace(/^['"]|['"]\s*$/g, "").trim() === "@warlock.js/*",
  );

  if (alreadyExcluded) {
    return "already excludes @warlock.js/*";
  }

  const indent = entries[0]?.match(/^(\s*)-/)?.[1] ?? "  ";
  lines.splice(keyIndex + 1, 0, `${indent}- '@warlock.js/*'`);

  return "added '@warlock.js/*'";
}

function appendOverrides(lines, overrides) {
  if (lines.some((line) => /^overrides:/.test(line))) {
    throw new Error("pnpm-workspace.yaml already has an overrides block; refusing to merge into it blindly");
  }

  while (lines.length > 0 && lines.at(-1).trim() === "") {
    lines.pop();
  }

  lines.push("", "# blog-check: every family member from the gate tarballs", "overrides:");

  for (const [name, spec] of Object.entries(overrides)) {
    lines.push(`  '${name}': '${spec}'`);
  }

  lines.push("");
}

function patchWorkspaceYaml(blogDir, overrides) {
  const file = path.join(blogDir, "pnpm-workspace.yaml");

  if (!fs.existsSync(file) && !overrides) {
    return { releaseAge: "no pnpm-workspace.yaml", overrides: 0 };
  }

  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const releaseAge = ensureReleaseAgeExclude(lines);

  if (overrides) {
    appendOverrides(lines, overrides);
  }

  fs.writeFileSync(file, lines.join("\n"));

  return { releaseAge, overrides: overrides ? Object.keys(overrides).length : 0 };
}

function pnpmStoreDir(blogDir) {
  const storeDir = path.join(blogDir, "node_modules", ".pnpm");

  if (!fs.existsSync(storeDir)) {
    throw new Error(`no node_modules/.pnpm in ${blogDir}; cannot count physical @warlock.js/core copies`);
  }

  return storeDir;
}

function verifyInstalledFamily(blogDir, version) {
  const scopeDir = path.join(blogDir, "node_modules", "@warlock.js");
  const mismatches = [];
  const topLevel = {};

  for (const name of fs.readdirSync(scopeDir)) {
    const installed = readJson(path.join(scopeDir, name, "package.json")).version;
    topLevel[name] = installed;

    if (installed !== version) {
      mismatches.push(`node_modules/@warlock.js/${name}@${installed}`);
    }
  }

  for (const required of ["core", "devtools"]) {
    if (!topLevel[required]) {
      throw new Error(`@warlock.js/${required} is not installed in ${scopeDir}`);
    }
  }

  const storeDir = pnpmStoreDir(blogDir);
  const familyDirs = fs.readdirSync(storeDir).filter((dir) => dir.startsWith("@warlock.js+"));

  for (const dir of familyDirs) {
    const name = dir.slice("@warlock.js+".length).split("@")[0];
    const manifest = path.join(storeDir, dir, "node_modules", "@warlock.js", name, "package.json");
    const installed = readJson(manifest).version;

    if (installed !== version) {
      mismatches.push(`.pnpm/${dir} -> ${installed}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`installed @warlock.js/* versions differ from ${version}:\n  ${mismatches.join("\n  ")}`);
  }

  const coreDirs = familyDirs.filter((dir) => dir.startsWith("@warlock.js+core@"));

  if (coreDirs.length !== 1) {
    throw new Error(`expected exactly one physical @warlock.js/core, found ${coreDirs.length}: ${coreDirs.join(", ")}`);
  }

  return { topLevel, storeEntries: familyDirs.length, coreDirs };
}

async function installFamily(context, details) {
  const { blogDir, mode, version, tarballDir } = context;
  const tarballSpecs = mode === "tarballs" ? readTarballSpecs(tarballDir, version) : undefined;

  const specFor = (name) => {
    if (mode === "registry") {
      return version;
    }

    const spec = tarballSpecs[name];

    if (!spec) {
      throw new Error(`the blog depends on ${name}, which has no tarball in ${tarballDir}`);
    }

    return spec;
  };

  details.packageJson = rewritePackageJson(blogDir, specFor, tarballSpecs);
  details.workspaceYaml = patchWorkspaceYaml(blogDir, tarballSpecs);
  log(`package.json: ${Object.keys(details.packageJson.rewritten).length} @warlock.js/* specs set (${mode})`);
  log(`pnpm-workspace.yaml: ${details.workspaceYaml.releaseAge}`);

  fs.rmSync(path.join(blogDir, "pnpm-lock.yaml"), { force: true });
  await runPnpm(context, "pnpm-install", ["install", "--no-frozen-lockfile"], TIMEOUTS.install);

  details.installed = verifyInstalledFamily(blogDir, version);
  log(`installed: every @warlock.js/* is ${version}, one physical core (${details.installed.coreDirs[0]})`);

  if (!fs.existsSync(context.warlockBin)) {
    throw new Error(`warlock bin missing after install: ${context.warlockBin}`);
  }
}

// ─── step 2: .env ────────────────────────────────────────────────────────────

function assertNoShadowingEnvFiles(blogDir) {
  const present = SHADOWING_ENV_FILES.filter((file) => fs.existsSync(path.join(blogDir, file)));

  if (present.length > 0) {
    throw new Error(`env files that would override the CI .env are present: ${present.join(", ")}`);
  }
}

function writeCiEnv(context, details) {
  const file = path.join(context.blogDir, ".env");

  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").startsWith(ENV_MARKER)) {
    throw new Error(`${file} exists and was not written by blog-check; refusing to overwrite it`);
  }

  assertNoShadowingEnvFiles(context.blogDir);

  const { db } = context;
  const values = {
    APP_NAME: "warlock-blog-ci",
    LOCALE_CODE: "en",
    TIMEZONE: "UTC",
    HTTP_HOST: HOST,
    HTTP_PORT: String(HTTP_PORT),
    BASE_URL,
    PUBLIC_APP_URL: BASE_URL,
    WEB_ORIGINS: BASE_URL,
    DB_DRIVER: "postgres",
    DB_HOST: db.host,
    DB_PORT: db.port,
    DB_NAME: db.name,
    DB_USERNAME: db.username,
    DB_PASSWORD: db.password,
    CACHE_DRIVER: "memory",
    STORAGE_DRIVER: "local",
    // Nothing in the check sends mail: dev captures it (core/src/mail/config.ts:68)
    // and production only connects on send. Dummy, unreachable values.
    MAIL_HOST: "127.0.0.1",
    MAIL_PORT: "1025",
    MAIL_SECURE: "false",
    MAIL_USERNAME: "ci",
    MAIL_PASSWORD: "ci",
    MAIL_FROM_NAME: "Warlock Blog CI",
    MAIL_FROM_ADDRESS: "ci@blog.test",
    CONTACT_RECIPIENT_EMAIL: "ci@blog.test",
    // src/config/auth.ts refuses to boot in production without JWT_SECRET.
    JWT_SECRET: randomBytes(32).toString("hex"),
    JWT_REFRESH_SECRET: randomBytes(32).toString("hex"),
  };

  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${/\s/.test(value) ? `"${value}"` : value}`)
    .join("\n");

  fs.writeFileSync(file, `${ENV_MARKER}\n${body}\n`);

  details.keys = Object.keys(values);
  details.baseUrl = BASE_URL;
}

// ─── step 3: devtools the way a user adds it ─────────────────────────────────

async function wireDevtools(context, details) {
  const before = readJson(path.join(context.blogDir, "package.json"));
  const output = await runWarlock(context, "warlock-add-devtools", ["add", "devtools", "--no-install"]);
  const after = readJson(path.join(context.blogDir, "package.json"));

  // `add devtools` only records a devDependency; there is no config to eject
  // (core/src/generations/features/devtools.feature.ts). `warlock dev` loads it
  // (core/src/dev-server/development-server.ts:90-92).
  if (after.devDependencies?.[DEVTOOLS_PACKAGE] !== before.devDependencies?.[DEVTOOLS_PACKAGE]) {
    throw new Error(
      `warlock add devtools changed the devtools spec: ${before.devDependencies?.[DEVTOOLS_PACKAGE]} -> ${after.devDependencies?.[DEVTOOLS_PACKAGE]}`,
    );
  }

  if (after.dependencies?.[DEVTOOLS_PACKAGE]) {
    throw new Error("warlock add devtools put devtools in dependencies; it must stay a dev dependency");
  }

  if (!output.includes(LINES.alreadyInstalled)) {
    throw new Error(`warlock add devtools did not report "${LINES.alreadyInstalled}"\n${tail(output)}`);
  }

  const warlockConfig = path.join(context.blogDir, "warlock.config.ts");
  details.devtoolsSpec = after.devDependencies[DEVTOOLS_PACKAGE];
  details.namedInWarlockConfig = fs.existsSync(warlockConfig) && fs.readFileSync(warlockConfig, "utf8").includes("devtools");
}

// ─── step 4: typings + typecheck ─────────────────────────────────────────────

async function typecheck(context, details) {
  // tsconfig.json includes .warlock/typings/*.d.ts, which a fresh checkout
  // lacks; generate.typings writes them (core/src/cli/commands/typings-generator.command.ts:28).
  await runWarlock(context, "warlock-generate-typings", ["generate.typings"]);

  await runCommand(
    "tsc",
    process.execPath,
    [path.join(context.blogDir, "node_modules", "typescript", "bin", "tsc"), "--noEmit"],
    { cwd: context.blogDir, logsDir: context.logsDir, timeoutMs: TIMEOUTS.command },
  );

  details.typecheck = "tsc --noEmit: 0 errors";
}

// ─── step 5: database ────────────────────────────────────────────────────────

async function migrateAndSeed(context, details) {
  await resetDatabase(context);
  await runPnpm(context, "migrate", ["run", "migrate"]);
  await runPnpm(context, "seed", ["run", "seed"]);
  details.database = `${context.db.host}:${context.db.port}/${context.db.name} (recreated empty)`;
}

/**
 * Drops and recreates the blog database. The release job runs this check twice
 * (tarballs, then registry) against one Postgres service; the second run must
 * start from an empty database, not the first run's migrated and seeded rows.
 */
async function resetDatabase(context) {
  const { host, port, username, password, name } = context.db;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`DB_NAME must be a plain identifier, got "${name}"`);
  }

  await runCommand(
    "reset-database",
    "psql",
    [
      "-h", host,
      "-p", String(port),
      "-U", username,
      "-d", "postgres",
      "-v", "ON_ERROR_STOP=1",
      "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      "-c", `CREATE DATABASE "${name}"`,
    ],
    { cwd: context.blogDir, logsDir: context.logsDir, timeoutMs: TIMEOUTS.command, env: { PGPASSWORD: password } },
  );
}

// ─── step 6: devtools in dev ─────────────────────────────────────────────────

function isPostsRequest(summary) {
  return summary.path === "/posts" || summary.path?.startsWith("/posts?");
}

async function waitForRecordedRequest(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    assertStillRunning(server, "the /posts request in devtools");

    const list = await getJson(`${BASE_URL}${DEVTOOLS_PATH}/api/requests`, "devtools request list");
    const found = list.find((summary) => isPostsRequest(summary) && summary.durationMs !== undefined);

    if (found) {
      return found;
    }

    await delay(500);
  }

  throw new Error(`devtools never recorded a finished /posts request within ${timeoutMs}ms`);
}

function isExplainable(query) {
  return (
    query.driver === "postgres" &&
    /^\s*(select|with)\b/i.test(query.sql ?? "") &&
    !(query.bindings ?? []).includes("[REDACTED]")
  );
}

async function explainQuery(requestId, queryId) {
  const url = `${BASE_URL}${DEVTOOLS_PATH}/api/requests/${encodeURIComponent(requestId)}/queries/${encodeURIComponent(queryId)}/explain`;
  const result = await httpRequest(url, { method: "POST" });

  if (result.status !== 200) {
    throw new Error(`EXPLAIN returned ${result.status}: ${result.body.slice(0, 300)}`);
  }

  const { plan } = parseJsonBody(result, "EXPLAIN");

  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error(`EXPLAIN returned no plan: ${result.body.slice(0, 300)}`);
  }

  return plan.length;
}

async function inspectPostsRequest(server, details) {
  const summary = await waitForRecordedRequest(server, 30 * SECOND);
  let request;

  try {
    request = await getJson(
      `${BASE_URL}${DEVTOOLS_PATH}/api/requests/${encodeURIComponent(summary.id)}`,
      "devtools request detail",
    );
  } catch (error) {
    // Tells an evicted/replaced record apart from a request that never
    // reached the detail route.
    const listAgain = await getJson(`${BASE_URL}${DEVTOOLS_PATH}/api/requests`, "devtools request list").catch(
      (listError) => errorMessage(listError),
    );
    const ids = Array.isArray(listAgain) ? listAgain.map((row) => `${row.id} ${row.method} ${row.path}`) : listAgain;
    throw new Error(`${errorMessage(error)}
list now: ${JSON.stringify(ids).slice(0, 1500)}`);
  }

  const phases = [...new Set(request.phases.map((phase) => phase.name))];
  details.request = {
    id: request.id,
    path: request.path,
    route: request.route,
    status: request.status,
    phases,
    queryCount: request.queries.length,
    queryDrivers: [...new Set(request.queries.map((query) => query.driver))],
    warnings: request.warnings.length,
  };

  const missing = REQUIRED_DEV_PHASES.filter((name) => !phases.includes(name));

  if (missing.length > 0) {
    throw new Error(`the /posts request is missing phases ${missing.join(", ")} (has: ${phases.join(", ")})`);
  }

  if (request.queries.length === 0) {
    throw new Error("the /posts request recorded no database queries");
  }

  const explainable = request.queries.find(isExplainable);

  if (!explainable) {
    throw new Error("the /posts request has no explainable Postgres SELECT");
  }

  details.explain = { queryId: explainable.id, planNodes: await explainQuery(request.id, explainable.id) };
}

async function checkDevtoolsInDev(context, details) {
  await withServer(context, "warlock-dev", ["dev"], async (server) => {
    await waitForHttpOk(server, `${BASE_URL}/health/live`, TIMEOUTS.devBoot);
    // Liveness answers before the web connector has installed its pages; the
    // ready block (core/src/dev-server/ready-block.ts) prints only once every
    // connector has bound, so a page request before it can 404.
    await waitForOutput(server, /➜\s+Web\s+http/, TIMEOUTS.devBoot, "dev ready block");
    log("dev server is up");

    const dashboard = await httpRequest(`${BASE_URL}${DEVTOOLS_PATH}`);

    if (dashboard.status !== 200 || !dashboard.contentType.includes("text/html")) {
      throw new Error(`GET ${DEVTOOLS_PATH} in dev returned ${dashboard.status} ${dashboard.contentType}`);
    }

    const page = await httpRequest(`${BASE_URL}/posts`, { timeoutMs: TIMEOUTS.firstDevPage });

    if (page.status !== 200) {
      throw new Error(`GET /posts in dev returned ${page.status}`);
    }

    await inspectPostsRequest(server, details);

    const mails = await getJson(`${BASE_URL}${DEVTOOLS_PATH}/api/mails`, "devtools mailbox");

    if (!Array.isArray(mails)) {
      throw new Error("devtools mailbox did not return a list");
    }

    details.mailboxEntries = mails.length;

    if (!server.output().includes(LINES.devtoolsReady)) {
      throw new Error(`dev log lacks "${LINES.devtoolsReady}"`);
    }

    details.log = server.logFile;
  });
}

// ─── step 7: production + browser smoke ──────────────────────────────────────

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "invalid-url";
  }
}

function watchBrowserErrors(page, smoke) {
  page.on("pageerror", (error) => smoke.pageErrors.push({ name: error.name, message: error.message }));
  page.on("console", (message) => {
    const isExpected404 = pathOf(message.location().url) === MISSING_PAGE && message.text().includes("404");

    if (message.type() === "error" && !isExpected404) {
      smoke.consoleErrors.push({ path: pathOf(message.location().url), text: message.text() });
    }
  });
  page.on("requestfailed", (request) =>
    smoke.requestFailures.push({ path: pathOf(request.url()), error: request.failure()?.errorText ?? "unknown" }),
  );
}

async function visitPage(page, pagePath, smoke) {
  const response = await page.goto(BASE_URL + pagePath, { waitUntil: "domcontentloaded", timeout: 15 * SECOND });
  const vessel = page.locator("#vessel");
  await vessel.waitFor({ state: "attached", timeout: 5 * SECOND });
  const text = (await vessel.innerText()).trim();

  smoke.pages.push({
    path: pagePath,
    status: response?.status() ?? null,
    finalPath: pathOf(page.url()),
    vesselHasText: text.length > 0,
    title: await page.title(),
  });

  if ((!response?.ok() && response?.status() !== 404) || text.length === 0) {
    throw new Error(`${pagePath} did not render usable SSR/hydrated content`);
  }
}

async function checkClientNavigation(page, smoke) {
  await page.goto(`${BASE_URL}/posts`, { waitUntil: "domcontentloaded" });
  const href = await page.locator("a[href^='/posts/']").first().getAttribute("href");

  if (!href || href === "/posts/") {
    throw new Error("posts archive offered no post detail link");
  }

  await page.locator(`a[href="${href}"]`).first().click();
  await page.waitForURL((url) => new URL(url).pathname === href, { timeout: 15 * SECOND });
  await page.waitForLoadState("networkidle");

  const text = (await page.locator("#vessel").innerText()).trim();
  smoke.navigation = { from: "/posts", href, finalPath: pathOf(page.url()), vesselHasText: text.length > 0 };

  if (smoke.navigation.finalPath !== href || !smoke.navigation.vesselHasText) {
    throw new Error("client post navigation did not produce a hydrated detail view");
  }
}

async function checkAnonymousGuards(page, smoke) {
  for (const pagePath of GUARDED_PAGES) {
    const response = await page.goto(BASE_URL + pagePath, { waitUntil: "domcontentloaded" });
    const finalPath = pathOf(page.url());
    smoke.guards.push({ path: pagePath, initialStatus: response?.status() ?? null, finalPath });

    if (finalPath !== "/login") {
      throw new Error(`${pagePath} anonymous guard ended at ${finalPath}`);
    }
  }
}

async function checkResponsiveForms(page, smoke) {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 667 });

  for (const [formPath, selector] of SMOKE_FORMS) {
    await page.goto(BASE_URL + formPath, { waitUntil: "domcontentloaded" });
    const form = page.locator(selector);
    await form.waitFor({ state: "visible", timeout: 5 * SECOND });
    const box = await form.boundingBox();
    const controls = await form.locator("input, textarea, button").count();
    smoke.responsiveForms.push({ path: formPath, selector, visible: Boolean(box), width: box?.width ?? 0, controls });

    if (!box || box.width <= 0 || box.width > MOBILE_WIDTH || controls === 0) {
      throw new Error(`${formPath} form is not usable at ${MOBILE_WIDTH}px`);
    }
  }
}

async function runBrowserSmoke(context, smoke) {
  const { chromium } = await import(pathToFileURL(context.playwrightModule).href);

  if (!chromium) {
    throw new Error(`${context.playwrightModule} does not export chromium`);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await browserContext.newPage();
    watchBrowserErrors(page, smoke);

    for (const pagePath of SMOKE_PAGES) {
      await visitPage(page, pagePath, smoke);
    }

    const notFound = smoke.pages.at(-1);

    if (notFound.status !== 404) {
      throw new Error(`expected ${MISSING_PAGE} to return 404, got ${notFound.status}`);
    }

    await checkClientNavigation(page, smoke);
    await checkAnonymousGuards(page, smoke);
    await checkResponsiveForms(page, smoke);

    if (smoke.pageErrors.length || smoke.consoleErrors.length || smoke.requestFailures.length) {
      throw new Error(
        `browser emitted ${smoke.pageErrors.length} page, ${smoke.consoleErrors.length} console, ${smoke.requestFailures.length} request failures`,
      );
    }
  } finally {
    await browser.close();
  }
}

function readyBannerPattern(version) {
  // core/src/cli/cli-commands.utils.ts:64 prints
  // "⚡ Warlock.js v<version> ✔ production server started[ in <n>ms]".
  return new RegExp(`v${escapeRegExp(version)} ✔ production server started`);
}

async function assertDevtoolsRefusedInProduction(details) {
  const statuses = {};

  for (const devtoolsPath of [DEVTOOLS_PATH, `${DEVTOOLS_PATH}/api/requests`]) {
    statuses[devtoolsPath] = (await httpRequest(BASE_URL + devtoolsPath)).status;

    if (statuses[devtoolsPath] !== 404) {
      throw new Error(`production GET ${devtoolsPath} returned ${statuses[devtoolsPath]}, expected 404`);
    }
  }

  details.devtools = { statuses };
}

async function checkProduction(context, details) {
  await runPnpm(context, "build", ["run", "build"], TIMEOUTS.build);

  const server = await withServer(context, "warlock-start", ["start"], async (server) => {
    details.banner = await waitForOutput(server, readyBannerPattern(context.version), TIMEOUTS.prodBoot, "ready banner");
    await waitForHttpOk(server, `${BASE_URL}/health/live`, 30 * SECOND);
    log(`production server is up: ${details.banner}`);

    details.smoke = { pages: [], navigation: null, guards: [], responsiveForms: [], pageErrors: [], consoleErrors: [], requestFailures: [] };
    await runBrowserSmoke(context, details.smoke);
    log(`browser smoke passed: ${details.smoke.pages.length} pages, ${details.smoke.responsiveForms.length} forms`);

    await assertDevtoolsRefusedInProduction(details);

    return server;
  });

  const output = server.output();

  if (output.includes(LINES.devtoolsReady)) {
    throw new Error(`production log contains "${LINES.devtoolsReady}"; devtools mounted outside development`);
  }

  // `warlock start` never registers devtools (the only registration site is
  // core/src/dev-server/development-server.ts:90-92), so its connector never
  // boots and never gets to log the refusal. Recorded, not required.
  details.devtools.refusalLogged = output.includes(LINES.devtoolsRefusal);
  details.devtools.mounted = false;
  details.log = server.logFile;
}

// ─── step 8: deploy in parts ─────────────────────────────────────────────────

function requireLines(server, lines) {
  const output = server.output();
  const missing = lines.filter((line) => !output.includes(line));

  if (missing.length > 0) {
    throw new Error(`${server.label} log lacks: ${missing.map((line) => `"${line}"`).join(", ")}`);
  }
}

async function checkWorkerRole(context, details) {
  const hasWorkerFile = fs
    .readdirSync(path.join(context.blogDir, "src", "app"))
    .some((module) => fs.existsSync(path.join(context.blogDir, "src", "app", module, "worker.ts")));

  await withServer(context, "warlock-start-worker", ["start", "--role=worker"], async (server) => {
    await waitForOutput(server, readyBannerPattern(context.version), TIMEOUTS.prodBoot, "ready banner");
    await waitForOutput(server, new RegExp(escapeRegExp(LINES.workerReady)), 10 * SECOND, "worker ready line");
    // Give a wrongly bound listener time to show up before probing.
    await delay(3 * SECOND);
    assertStillRunning(server, "the port probe");

    if (await isPortOpen(HTTP_PORT)) {
      throw new Error(`--role=worker is accepting connections on ${HTTP_PORT}`);
    }

    requireLines(server, [LINES.httpNotStarted]);

    details.worker = {
      portBound: false,
      lines: [LINES.workerReady, LINES.httpNotStarted],
      // The blog has no worker.ts; its scheduler jobs (src/app/auth/main.ts,
      // started in src/app/shared/main.ts) are what this role runs.
      workerTs: hasWorkerFile,
      log: server.logFile,
    };
  });
}

async function checkApiRole(context, details) {
  await withServer(context, "warlock-start-api", ["start", "--role=api"], async (server) => {
    await waitForOutput(server, readyBannerPattern(context.version), TIMEOUTS.prodBoot, "ready banner");

    const api = await waitForHttpOk(server, `${BASE_URL}/api/posts`, 30 * SECOND);
    parseJsonBody(api, "--role=api GET /api/posts");

    const page = await httpRequest(`${BASE_URL}/posts`);

    if (page.status !== 404) {
      throw new Error(`--role=api served page /posts with ${page.status}, expected 404`);
    }

    requireLines(server, [LINES.pagesNotInstalled, LINES.schedulerNotStarted]);

    details.api = {
      apiRoute: { path: "/api/posts", status: api.status },
      pageRoute: { path: "/posts", status: page.status },
      lines: [LINES.pagesNotInstalled, LINES.schedulerNotStarted],
      log: server.logFile,
    };
  });
}

// ─── orchestration ───────────────────────────────────────────────────────────

async function runStep(evidence, name, action) {
  const details = {};
  const record = { name, status: "running", startedAt: new Date().toISOString(), details };
  const started = Date.now();

  evidence.steps.push(record);
  log(`▶ ${name}`);

  try {
    await action(details);
    record.status = "passed";
    log(`✔ ${name} (${Math.round((Date.now() - started) / SECOND)}s)`);
  } catch (error) {
    record.status = "failed";
    record.error = errorMessage(error);
    log(`✖ ${name}: ${record.error}`);
    throw error;
  } finally {
    record.durationMs = Date.now() - started;
  }
}

function writeEvidence(evidencePath, evidence) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeJson(evidencePath, evidence);
  log(`evidence: ${evidencePath}`);
}

function stopEverythingOnSignal() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      log(`${signal}: stopping ${liveProcesses.size} process group(s)`);

      for (const handle of liveProcesses) {
        killGroup(handle.child, "SIGKILL");
      }

      process.exit(130);
    });
  }
}

async function main() {
  const evidencePath = process.env.EVIDENCE_PATH ? path.resolve(process.env.EVIDENCE_PATH) : undefined;
  const evidence = { check: "blog", startedAt: new Date().toISOString(), steps: [] };

  stopEverythingOnSignal();

  try {
    if (!evidencePath) {
      throw new Error("missing required env EVIDENCE_PATH");
    }

    assertDisposableRunner();

    const inputs = readInputs();
    const logsDir = path.join(path.dirname(evidencePath), "blog-check-logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const context = {
      ...inputs,
      logsDir,
      warlockBin: path.join(inputs.blogDir, "node_modules", "@warlock.js", "core", "bin", "warlock.js"),
    };

    Object.assign(evidence, {
      warlockVersion: inputs.version,
      mode: inputs.mode,
      blogDir: inputs.blogDir,
      tarballDir: inputs.tarballDir,
      baseUrl: BASE_URL,
      logsDir,
    });
    log(`Warlock.js ${inputs.version} from ${inputs.mode}, blog at ${inputs.blogDir}`);

    await runStep(evidence, "install family", (details) => installFamily(context, details));
    await runStep(evidence, "write CI .env", async (details) => writeCiEnv(context, details));
    await runStep(evidence, "add devtools", (details) => wireDevtools(context, details));
    await runStep(evidence, "typings + tsc", (details) => typecheck(context, details));
    await runStep(evidence, "migrate + seed", (details) => migrateAndSeed(context, details));
    await runStep(evidence, "dev: devtools records a page request", (details) => checkDevtoolsInDev(context, details));
    await runStep(evidence, "production: build, start, smoke, devtools 404", (details) => checkProduction(context, details));
    await runStep(evidence, "deploy in parts: --role=worker", (details) => checkWorkerRole(context, details));
    await runStep(evidence, "deploy in parts: --role=api", (details) => checkApiRole(context, details));

    evidence.result = "passed";
    log("PASSED");
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = errorMessage(error);
    process.exitCode = 1;
    console.error(`${TAG} FAILED: ${evidence.failure}`);
  } finally {
    for (const handle of liveProcesses) {
      await stopProcess(handle);
    }

    evidence.finishedAt = new Date().toISOString();

    if (evidencePath) {
      writeEvidence(evidencePath, evidence);
    }
  }
}

await main();
