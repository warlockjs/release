#!/usr/bin/env node
/**
 * WARLOCK_GENERATED_BROWSER_ORACLE
 *
 * Invoked by the zero-edit generator gate as a plain child process
 * (`zero-edit-generator-gate.ts:264-269`, and again with `--mutation-control`
 * appended at `:296-300`):
 *
 *   node generated-browser-oracle.mjs --app-root <app> --baseline-root <baseline> \
 *     --features-json <json array> --candidate-version <semver> --format json \
 *     [--mutation-control]
 *
 * It boots the GENERATED app's own `warlock dev` and `warlock build` +
 * `warlock start`, drives a real Chrome/Chromium instance over the raw
 * DevTools Protocol (no Playwright — see "Browser driver" below), and prints
 * the `BrowserCertificate` JSON the gate's `parseBrowserCertificate`
 * (`zero-edit-generator-gate.ts:469-484`) requires on stdout.
 *
 * ## Discovery, not fixtures
 *
 * The generated app is feature-arbitrary: it is whatever `create-warlock` plus
 * `warlock add <feature>` produced for the case under test, never this
 * repository's own fixtures. This adapter therefore:
 *
 *  - discovers the app's home page from its own `src/web/**\/*.page.tsx`
 *    tree (`discoverPages`, `findHomePage`) instead of assuming a path;
 *  - nominates its mutation token by pattern-matching a `useState` counter
 *    idiom actually present in that discovered page's own source
 *    (`findIncrementMutationCandidate`) instead of pointing at a packed
 *    library file;
 *  - refuses to fabricate `true` for click/link assertions it cannot honestly
 *    make — see "Honesty gaps" below.
 *
 * ## Browser driver: raw CDP, not Playwright
 *
 * `builder/` is a standalone npm project (its own `package.json` +
 * `package-lock.json`, not a member of the root `pnpm-workspace.yaml`
 * package list) with no `playwright` dependency anywhere in its install
 * tree. `web/tests/acceptance/published-react-gate.mjs` requires Playwright
 * from the *workspace* root (`loadPlaywright`, `web/tests/acceptance/published-react-gate.mjs:974-986`),
 * which is not reachable from a script run out of `builder/`. This adapter
 * instead drives an installed Chrome/Chromium over raw CDP, following the
 * pattern in `create-warlock/tests/acceptance/starter-browser-gate.mjs`
 * (`Cdp` class, `:467-529`): only Node built-ins (`node:child_process`,
 * the global `WebSocket`/`fetch`), no extra dependency.
 *
 * ## Honesty gaps (reported to stdout/stderr, never silently papered over)
 *
 * `clickPassed` requires a `useState` counter idiom — `setX(y => y + 1)` —
 * literally present in the discovered home page's source, wired to a
 * `<button>`. Not every possible generated app has one (a feature that adds
 * only backend surface plainly does not). When this adapter cannot find one,
 * it does NOT emit `clickPassed: true`; it fails loudly with
 * `NO_INCREMENT_BUTTON_FOUND` naming the file it searched, exits non-zero,
 * and prints no certificate. Likewise `linkSpaNavigationPassed` requires at
 * least one same-origin anchor with no `target` attribute in the rendered
 * DOM; finding none fails loudly with `NO_INTERNAL_LINK_FOUND` instead of
 * inventing a link.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertExistingDirectory, parseOracleArguments } from "./oracle-arguments.mjs";

const ASSERTION_FAILED_MARKER = "ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED";
/**
 * Printed INSTEAD of {@link ASSERTION_FAILED_MARKER} when a `--mutation-control`
 * run still passed every assertion. The gate matches only the marker above, so
 * emitting this token makes an undetected corruption fail the gate rather than
 * satisfy it.
 */
const CONTROL_NOT_DETECTED_MARKER = "ZERO_EDIT_BROWSER_ORACLE_CONTROL_NOT_DETECTED";
const PAGE_EXTENSION = ".page.tsx";
const NON_ROUTED_PAGE_BASENAMES = new Set(["error.page.tsx", "404.page.tsx"]);

/**
 * Recursively list every `*.page.tsx` file beneath `<appRoot>/src/web`,
 * excluding the two special boundary files that own no URL of their own
 * (`error.page.tsx`, `404.page.tsx` — see the create-a-page skill).
 *
 * @param {string} appRoot Absolute root of the generated app.
 * @returns {Promise<Array<{ absolutePath: string, relativeToWebRoot: string }>>}
 */
export async function discoverPages(appRoot) {
  const webRoot = path.join(appRoot, "src", "web");
  const pages = [];

  async function walk(directory) {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(PAGE_EXTENSION)) continue;
      if (NON_ROUTED_PAGE_BASENAMES.has(entry.name)) continue;

      pages.push({
        absolutePath,
        relativeToWebRoot: path.relative(webRoot, absolutePath).split(path.sep).join("/"),
      });
    }
  }

  await walk(webRoot);
  return pages;
}

/**
 * Extract an explicitly declared `export const route = ...` path from a page
 * source file, matching the two literal shapes the framework's own build
 * accepts: a bare string, or an object literal with a `path` property. Both
 * must be plain string literals — the build refuses anything computed, and so
 * do we, since we cannot safely execute arbitrary generated app code here.
 *
 * @param {string} source Raw `*.page.tsx` file contents.
 * @returns {string | undefined} The declared route path, or undefined when
 *   the page has no (recognisable, literal) `route` export.
 */
export function extractDeclaredRoutePath(source) {
  const match = source.match(/export\s+const\s+route\s*=\s*(\{[\s\S]*?\}|["'`][^"'`]*["'`])\s*(?:as\s+const\s*)?;/);
  if (!match) return undefined;

  const declaration = match[1];

  if (declaration.startsWith("{")) {
    const pathMatch = declaration.match(/path\s*:\s*["'`]([^"'`]*)["'`]/);
    return pathMatch ? pathMatch[1] : undefined;
  }

  return declaration.slice(1, -1);
}

/**
 * Derive a page's route path from its location beneath `src/web` when it
 * declares no explicit `route`, following the filesystem-routing rules in the
 * create-a-page skill: `index.page.tsx` claims its directory, `[name]`
 * becomes `:name`, and `(group)` directories contribute nothing.
 *
 * @param {string} relativeToWebRoot Forward-slash path relative to `src/web`.
 * @returns {string} The derived route path (always starting with `/`).
 */
export function deriveFilesystemRoutePath(relativeToWebRoot) {
  const withoutExtension = relativeToWebRoot.slice(0, -PAGE_EXTENSION.length);
  const segments = withoutExtension.split("/").filter(segment => segment.length > 0);

  if (segments.at(-1) === "index") segments.pop();

  const routeSegments = segments
    .filter(segment => !(segment.startsWith("(") && segment.endsWith(")")))
    .map(segment => (/^\[[^[\]]+\]$/.test(segment) ? `:${segment.slice(1, -1)}` : segment));

  return routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
}

/**
 * Resolve the effective route path of a discovered page: its explicit
 * `route` export when present, otherwise its filesystem-derived path.
 *
 * @param {{ absolutePath: string, relativeToWebRoot: string }} page A page found by {@link discoverPages}.
 * @returns {Promise<string>} The page's effective route path.
 */
export async function resolvePageRoutePath(page) {
  const source = await readFile(page.absolutePath, "utf8");
  return extractDeclaredRoutePath(source) ?? deriveFilesystemRoutePath(page.relativeToWebRoot);
}

/**
 * Find the generated app's home page — the discovered page whose effective
 * route path is exactly `/`.
 *
 * @param {Array<{ absolutePath: string, relativeToWebRoot: string, routePath: string }>} pagesWithRoutes
 * @returns {{ absolutePath: string, relativeToWebRoot: string, routePath: string } | undefined}
 */
export function findHomePage(pagesWithRoutes) {
  return pagesWithRoutes.find(page => page.routePath === "/");
}

/**
 * Locate a `useState` "click to prove hydration" idiom in a page's source:
 * a setter obtained from `useState` invoked as `setX(y => y + 1)`, i.e. a
 * plain numeric increment. This is the ONE idiom this adapter treats as an
 * honest, generic proof that clicking a real button changed live React
 * state — see "Honesty gaps" in the module doc for what happens when a page
 * has no such idiom.
 *
 * The result also carries a zero-based `buttonIndex`: the ordinal position,
 * among every `<button` occurrence in the file, of the nearest preceding
 * `<button` tag before the matched increment call. That index is resolved
 * against `document.querySelectorAll("button")` in the live DOM rather than
 * matching on visible text, so it survives i18n/JSX-expression button labels
 * this adapter cannot safely evaluate statically.
 *
 * @param {string} source Raw `*.page.tsx` file contents.
 * @returns {{ find: string, replacement: string, buttonIndex: number } | undefined}
 */
export function findIncrementMutationCandidate(source) {
  const setters = [...source.matchAll(/const\s*\[\s*\w+\s*,\s*(set[A-Z]\w*)\s*\]\s*=\s*useState\b/g)].map(
    match => match[1],
  );

  for (const setter of setters) {
    // The parameter may or may not be parenthesised. The scaffold's own
    // .prettierrc sets `arrowParens: "always"`, so the generated source says
    // `setCount((c) => c + 1)` — but a hand-written page, or one formatted
    // under a different config, says `setCount(c => c + 1)`. Matching only the
    // bare form made this finder silently blind to the exact shape `warlock
    // add web` generates, which would fail the row with NO_INCREMENT_BUTTON_FOUND
    // and read as "this app has no counter" rather than "this regex is wrong".
    const incrementPattern = new RegExp(
      `${setter}\\(\\s*\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*\\1\\s*\\+\\s*1\\s*\\)`,
    );
    const match = source.match(incrementPattern);
    if (!match) continue;

    // Preserve the source's own parenthesisation in the replacement, so the
    // mutated file stays formatted the way the project formats it.
    const parameter = match[0].includes(`(${match[1]})`) ? `(${match[1]})` : match[1];
    const find = match[0];
    const replacement = `${setter}(${parameter} => ${match[1]})`;
    const buttonIndex = countPrecedingButtons(source, match.index ?? 0);

    return { find, replacement, buttonIndex };
  }

  return undefined;
}

function countPrecedingButtons(source, offset) {
  const before = source.slice(0, offset);
  const matches = before.match(/<button\b/g);
  return matches ? matches.length - 1 : 0;
}

/**
 * Assemble the exact `BrowserCertificate` JSON shape the gate's
 * `parseBrowserCertificate` requires (`zero-edit-generator-gate.ts:113-130`).
 * Throws rather than emitting a shape that would only fail validation one
 * level up, so a bug here is caught at the point it was made.
 *
 * @param {object} options
 * @param {string} options.appRoot Absolute app root, matching the `--app-root` argument exactly.
 * @param {{ clickPassed: boolean, linkSpaNavigationPassed: boolean, hmrStatePreserved: boolean, consoleErrors: string[], pageErrors: string[] }} options.development
 * @param {{ clickPassed: boolean, linkSpaNavigationPassed: boolean, consoleErrors: string[], pageErrors: string[] }} options.production
 * @param {{ relativePath: string, find: string, replacement: string }} options.mutation
 * @returns {object} The certificate object, ready for `JSON.stringify`.
 */
export function buildCertificate({ appRoot, development, production, mutation }) {
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) {
    throw new Error("buildCertificate requires an absolute appRoot.");
  }
  for (const key of ["clickPassed", "linkSpaNavigationPassed", "hmrStatePreserved"]) {
    if (typeof development?.[key] !== "boolean") throw new Error(`development.${key} must be a boolean.`);
  }
  for (const key of ["clickPassed", "linkSpaNavigationPassed"]) {
    if (typeof production?.[key] !== "boolean") throw new Error(`production.${key} must be a boolean.`);
  }
  for (const phase of [development, production]) {
    if (!Array.isArray(phase?.consoleErrors) || !Array.isArray(phase?.pageErrors)) {
      throw new Error("Both phases require consoleErrors and pageErrors arrays.");
    }
  }
  if (!mutation?.relativePath || !mutation.find || !mutation.replacement || mutation.find === mutation.replacement) {
    throw new Error("mutation requires a relativePath, a find token, and a distinct replacement.");
  }
  if (path.isAbsolute(mutation.relativePath)) {
    throw new Error("mutation.relativePath must be relative to the app root, not absolute.");
  }

  return {
    schemaVersion: 1,
    appRoot,
    development: {
      clickPassed: development.clickPassed,
      linkSpaNavigationPassed: development.linkSpaNavigationPassed,
      hmrStatePreserved: development.hmrStatePreserved,
      consoleErrors: development.consoleErrors,
      pageErrors: development.pageErrors,
    },
    production: {
      clickPassed: production.clickPassed,
      linkSpaNavigationPassed: production.linkSpaNavigationPassed,
      consoleErrors: production.consoleErrors,
      pageErrors: production.pageErrors,
    },
    mutation,
  };
}

/**
 * Whether a phase's own measured evidence satisfies the gate's certificate
 * requirements: every required boolean true, and both error arrays empty.
 *
 * @param {object} phase A `development`/`production` measured result.
 * @param {boolean} requireHmr Whether `hmrStatePreserved` must also be true (development only).
 * @returns {boolean}
 */
export function phaseFullyPassed(phase, requireHmr) {
  return (
    phase.clickPassed === true &&
    phase.linkSpaNavigationPassed === true &&
    (!requireHmr || phase.hmrStatePreserved === true) &&
    phase.consoleErrors.length === 0 &&
    phase.pageErrors.length === 0
  );
}

/**
 * Decide the adapter's final exit behaviour from measured development and
 * production evidence, honouring the gate's `--mutation-control` contract
 * (`zero-edit-generator-gate.ts:282-310`):
 *
 *  - Normal mode: pass (print the certificate, exit 0) only when both phases
 *    fully passed; otherwise fail with a plain diagnostic, no marker.
 *  - `--mutation-control`: the gate expects this run to FAIL, because it just
 *    corrupted the one behavioral token this adapter nominated. This
 *    function therefore always reports failure with the required
 *    `ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED` marker under mutation
 *    control — printing a distinct "control was not detected" message (still
 *    carrying the marker, since the gate's check for the marker does not
 *    distinguish why the run failed) on the one path where corruption
 *    unexpectedly went unnoticed.
 *
 * @param {object} options
 * @param {boolean} options.mutationControl
 * @param {object} options.development Measured development phase result.
 * @param {object} options.production Measured production phase result.
 * @param {{ relativePath: string, find: string, replacement: string }} options.mutation
 * @returns {{ ok: boolean, exitCode: number, message: string }}
 */
export function decideOutcome({ mutationControl, development, production, mutation }) {
  const developmentPassed = phaseFullyPassed(development, true);
  const productionPassed = phaseFullyPassed(production, false);
  const bothPassed = developmentPassed && productionPassed;

  if (!mutationControl) {
    if (bothPassed) return { ok: true, exitCode: 0, message: "" };
    return {
      ok: false,
      exitCode: 1,
      message: `Browser oracle assertions failed. development=${JSON.stringify(development)} production=${JSON.stringify(production)}`,
    };
  }

  if (!bothPassed) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `${ASSERTION_FAILED_MARKER}: mutation control correctly detected the corrupted token ` +
        `${JSON.stringify(mutation.find)} in ${mutation.relativePath}. development=${JSON.stringify(development)} ` +
        `production=${JSON.stringify(production)}`,
    };
  }

  // DELIBERATELY WITHOUT THE MARKER. The gate accepts the red control only when
  // this run exits non-zero AND prints ASSERTION_FAILED_MARKER
  // (`zero-edit-generator-gate.ts:299-302`). If the corruption went undetected,
  // printing the marker here would tell the gate the control worked when it did
  // not — a dead red control that reads as a live one, which is the precise
  // failure this stage exists to prevent. So this branch exits non-zero under a
  // DIFFERENT token; the gate's own check then refuses it and the operator gets
  // "Browser oracle did not fail on the real generated-file mutation control",
  // which is the truth.
  return {
    ok: false,
    exitCode: 1,
    message:
      `${CONTROL_NOT_DETECTED_MARKER}: mutation control did NOT detect the corrupted token ` +
      `${JSON.stringify(mutation.find)} in ${mutation.relativePath} — every assertion still passed after corruption. ` +
      "This is a failure of the oracle's own assertions, not of the generated app.",
  };
}

// ---------------------------------------------------------------------------
// Browser orchestration (not exercised by unit tests — no real browser there)
// ---------------------------------------------------------------------------

/**
 * Resolve an installed Chrome/Chromium/Edge executable, checking an explicit
 * override env var first and then the conventional per-OS install paths.
 * Never downloads or assumes a package-managed browser.
 *
 * @returns {string} Absolute path to a browser executable.
 */
export function resolveBrowserExecutable() {
  const override = process.env.WARLOCK_ORACLE_CHROME_PATH ?? process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override && existsSync(override)) return override;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ];

  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error(
      "No installed Chrome/Chromium/Edge executable found. Set WARLOCK_ORACLE_CHROME_PATH to an explicit browser binary.",
    );
  }
  return found;
}

/** Minimal raw-CDP client, adapted from create-warlock/tests/acceptance/starter-browser-gate.mjs:467-529. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", event => this.receive(event.data));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CHROME_CDP_CONNECT_FAILED")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, listener, sessionId) {
    this.listeners.push({ method, listener, sessionId });
  }

  receive(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(`CDP ${message.error.message}`)) : pending.resolve(message.result);
      return;
    }
    for (const item of this.listeners) {
      if (item.method === message.method && (!item.sessionId || item.sessionId === message.sessionId)) {
        item.listener(message.params);
      }
    }
  }

  close() {
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
    this.pending.clear();
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(`BROWSER_EVALUATION_FAILED: ${result.exceptionDetails.text}`);
  return result.result.value;
}

async function waitForExpression(cdp, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, `Boolean(${expression})`)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`BROWSER_WAIT_TIMEOUT: ${expression}; ${formatError(lastError ?? "condition stayed false")}`);
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForJson(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CHROME_EXITED_EARLY: code=${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`CHROME_CDP_TIMEOUT: ${formatError(lastError)}`);
}

async function waitForServer(baseUrl, server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited early with code ${server.exitCode}.`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok || response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Server did not become ready at ${baseUrl}: ${formatError(lastError)}`);
}

/**
 * Drive one already-booted phase (development or production) of the
 * generated app over CDP: click the discovered increment button, click the
 * first internal same-origin anchor, and — development only — hot-edit the
 * home page's button label and confirm the DOM updates with zero document
 * requests.
 *
 * Honesty gaps are thrown, not swallowed: a missing button/link means this
 * function throws `NO_INCREMENT_BUTTON_FOUND` / `NO_INTERNAL_LINK_FOUND`
 * rather than returning a fabricated `true`.
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.chromeExecutable
 * @param {{ absolutePath: string, buttonIndex: number }} options.homePage
 * @param {boolean} options.includeHmr
 * @returns {Promise<object>} The phase's measured evidence.
 */
async function driveBrowserPhase({ baseUrl, chromeExecutable, homePage, includeHmr }) {
  const cdpPort = await reservePort();
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "warlock-browser-oracle-profile-"));
  const chrome = spawn(
    chromeExecutable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const documentRequests = [];
  let cdp;

  try {
    const versionInfo = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`, chrome, 30_000);
    cdp = await Cdp.connect(versionInfo.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    cdp.on(
      "Runtime.consoleAPICalled",
      event => {
        if (event.type === "error") consoleErrors.push(event.args.map(argument => argument.value ?? argument.description).join(" "));
      },
      sessionId,
    );
    cdp.on("Runtime.exceptionThrown", event => pageErrors.push(event.exceptionDetails?.text ?? "browser exception"), sessionId);
    cdp.on(
      "Network.requestWillBeSent",
      event => {
        if (event.type === "Document") documentRequests.push(event.request.url);
      },
      sessionId,
    );

    await Promise.all([
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
      cdp.send("Page.enable", {}, sessionId),
    ]);

    await cdp.send("Page.navigate", { url: baseUrl }, sessionId);
    await waitForExpression(cdp, sessionId, `document.readyState === "complete"`, 30_000);
    await waitForExpression(
      cdp,
      sessionId,
      `Object.keys(document.querySelector("#root") ?? {}).some(key => key.startsWith("__reactContainer$"))`,
      30_000,
    );

    // --- click assertion ---------------------------------------------------
    const hasButton = await evaluate(cdp, sessionId, `document.querySelectorAll("button")[${homePage.buttonIndex}] !== undefined`);
    if (!hasButton) throw new Error(`NO_INCREMENT_BUTTON_FOUND: button index ${homePage.buttonIndex} is not present in the rendered DOM.`);
    const beforeClickText = await evaluate(cdp, sessionId, "document.body.innerText");
    await evaluate(
      cdp,
      sessionId,
      `(() => { document.querySelectorAll("button")[${homePage.buttonIndex}].click(); return true; })()`,
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => { document.querySelectorAll("button")[${homePage.buttonIndex}].click(); return true; })()`,
    );
    await delay(250);
    const afterClickText = await evaluate(cdp, sessionId, "document.body.innerText");
    const clickPassed = afterClickText !== beforeClickText;

    // --- SPA navigation assertion -------------------------------------------
    const internalLinkCount = await evaluate(
      cdp,
      sessionId,
      `[...document.querySelectorAll("a")].filter(a => a.getAttribute("href")?.startsWith("/") && !a.target).length`,
    );
    if (internalLinkCount === 0) {
      throw new Error("NO_INTERNAL_LINK_FOUND: no same-origin anchor without a target attribute is present in the rendered DOM.");
    }
    await evaluate(cdp, sessionId, `window.__WARLOCK_ORACLE_LINK_REALM__ = "alive"; true`);
    const documentsBeforeLink = documentRequests.length;
    await evaluate(
      cdp,
      sessionId,
      `(() => { [...document.querySelectorAll("a")].find(a => a.getAttribute("href")?.startsWith("/") && !a.target).click(); return true; })()`,
    );
    await delay(500);
    const realmSurvived = await evaluate(cdp, sessionId, `window.__WARLOCK_ORACLE_LINK_REALM__ === "alive"`);
    const linkSpaNavigationPassed = documentRequests.length === documentsBeforeLink && realmSurvived === true;

    const result = { clickPassed, linkSpaNavigationPassed, consoleErrors, pageErrors };

    // --- HMR assertion (development only) -----------------------------------
    if (includeHmr) {
      const original = await readFile(homePage.absolutePath, "utf8");
      const probeMarker = "__WARLOCK_ORACLE_HMR_PROBE__";
      const buttonBlockPattern = new RegExp(
        `(${"<button\\b[^>]*onClick=\\{[^}]*\\}[^>]*>"}[\\s\\S]*?)(<\\/button>)`,
      );
      // Append a plain, visible text marker just before the closing tag of
      // the FIRST button block found — a minimal, reversible source edit.
      const match = original.match(buttonBlockPattern);
      if (!match) throw new Error("NO_HMR_PROBE_TARGET: could not find a <button ...>...</button> block to hot-edit.");
      const mutated = original.replace(buttonBlockPattern, `$1${probeMarker}$2`);

      await evaluate(cdp, sessionId, `window.__WARLOCK_ORACLE_HMR_REALM__ = "alive"; true`);
      const documentsBeforeHmr = documentRequests.length;
      try {
        await writeFile(homePage.absolutePath, mutated, "utf8");
        await waitForExpression(cdp, sessionId, `document.body.innerText.includes(${JSON.stringify(probeMarker)})`, 20_000);
      } finally {
        await writeFile(homePage.absolutePath, original, "utf8");
      }
      const hmrDocumentRequests = documentRequests.length - documentsBeforeHmr;
      const hmrRealmSurvived = await evaluate(cdp, sessionId, `window.__WARLOCK_ORACLE_HMR_REALM__ === "alive"`);
      result.hmrStatePreserved = hmrDocumentRequests === 0 && hmrRealmSurvived === true;
    }

    return result;
  } finally {
    cdp?.close();
    if (chrome.exitCode === null) chrome.kill();
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function reserveHttpPort() {
  return reservePort();
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
  } else {
    child.kill("SIGTERM");
    await delay(1_000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function ownedEnv(port) {
  const env = { ...process.env };
  delete env.HTTP_PORT;
  delete env.NODE_ENV;
  delete env.BASE_URL;
  delete env.APP_NAME;
  return { ...env, HTTP_PORT: String(port), HOST: "127.0.0.1" };
}

async function runCommand(command, args, { cwd, env, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.once("error", error => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start: ${formatError(error)}`));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} exited ${code}.\nSTDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`));
    });
  });
}

function findWarlockBin(appRoot) {
  return path.join(appRoot, "node_modules", "@warlock.js", "core", "bin", "warlock.js");
}

/**
 * Run the complete development phase: boot `warlock dev` on a freshly
 * reserved port, drive it over CDP (including the HMR probe), then stop it
 * and wait for the port to be released so production can reuse a clean slate.
 */
async function runDevelopmentPhase({ appRoot, homePage, chromeExecutable }) {
  const port = await reserveHttpPort();
  const warlockBin = findWarlockBin(appRoot);
  const server = spawn(process.execPath, [warlockBin, "dev"], { cwd: appRoot, env: ownedEnv(port), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, server, 90_000);
    return await driveBrowserPhase({ baseUrl, chromeExecutable, homePage, includeHmr: true });
  } finally {
    await terminate(server);
  }
}

/** Run the complete production phase: `warlock build` then `warlock start`, driven the same way but without the HMR probe. */
async function runProductionPhase({ appRoot, homePage, chromeExecutable }) {
  const warlockBin = findWarlockBin(appRoot);
  await runCommand(process.execPath, [warlockBin, "build"], { cwd: appRoot, env: ownedEnv(0), timeoutMs: 5 * 60_000, label: "warlock build" });
  const port = await reserveHttpPort();
  const server = spawn(process.execPath, [warlockBin, "start"], { cwd: appRoot, env: ownedEnv(port), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, server, 90_000);
    return await driveBrowserPhase({ baseUrl, chromeExecutable, homePage, includeHmr: false });
  } finally {
    await terminate(server);
  }
}

function tail(value, lines = 60) {
  return value.split(/\r?\n/).slice(-lines).join("\n");
}

function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Full end-to-end run: parse arguments, discover the app's home page and
 * mutation candidate, drive development then production, and print the
 * `BrowserCertificate` (or fail loudly per {@link decideOutcome}).
 *
 * @param {string[]} argv `process.argv.slice(2)`.
 * @returns {Promise<number>} The process exit code.
 */
export async function main(argv) {
  const options = parseOracleArguments(argv);
  const appRoot = await assertExistingDirectory("--app-root", options.appRoot);

  const pages = await discoverPages(appRoot);
  const pagesWithRoutes = await Promise.all(
    pages.map(async page => ({ ...page, routePath: await resolvePageRoutePath(page) })),
  );
  const homePage = findHomePage(pagesWithRoutes);
  if (!homePage) {
    throw new Error(`NO_HOME_PAGE_FOUND: no *.page.tsx beneath ${path.join(appRoot, "src", "web")} resolves to route "/".`);
  }

  const source = await readFile(homePage.absolutePath, "utf8");
  const mutationCandidate = findIncrementMutationCandidate(source);
  if (!mutationCandidate) {
    throw new Error(
      `NO_INCREMENT_BUTTON_FOUND: ${homePage.absolutePath} has no "useState" counter idiom ` +
        '(a setter invoked as "setX(y => y + 1)") this adapter can honestly click-test and nominate as a mutation control.',
    );
  }

  const chromeExecutable = resolveBrowserExecutable();
  const homePageForDriving = { absolutePath: homePage.absolutePath, buttonIndex: mutationCandidate.buttonIndex };

  const development = await runDevelopmentPhase({ appRoot, homePage: homePageForDriving, chromeExecutable });
  const production = await runProductionPhase({ appRoot, homePage: homePageForDriving, chromeExecutable });

  const mutation = {
    relativePath: path.join("src", "web", homePage.relativeToWebRoot),
    find: mutationCandidate.find,
    replacement: mutationCandidate.replacement,
  };

  const outcome = decideOutcome({ mutationControl: options.mutationControl, development, production, mutation });

  if (outcome.ok) {
    const certificate = buildCertificate({ appRoot, development, production, mutation });
    process.stdout.write(`${JSON.stringify(certificate)}\n`);
    return 0;
  }

  if (options.mutationControl) {
    process.stdout.write(`${outcome.message}\n`);
  } else {
    process.stderr.write(`${outcome.message}\n`);
  }
  return outcome.exitCode;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
