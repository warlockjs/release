/**
 * Shared argument parsing for the two per-case zero-edit generator oracles.
 *
 * The gate builds one identical argument vector for both the generated-output
 * oracle and the browser oracle (`zero-edit-generator-gate.ts:487-489`):
 *
 *   --app-root <app> --baseline-root <baseline> --features-json <json array>
 *   --candidate-version <semver> --format json
 *
 * and appends `--mutation-control` to the browser oracle's second invocation
 * (`:296-300`). Parsing lives here once so the two adapters cannot drift on
 * the vector the gate actually hands them.
 */

import { realpath } from "node:fs/promises";

const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const VALUE_FLAGS = new Map([
  ["--app-root", "appRoot"],
  ["--baseline-root", "baselineRoot"],
  ["--features-json", "featuresJson"],
  ["--candidate-version", "candidateVersion"],
  ["--format", "format"],
]);

/**
 * Parse the oracle argument vector.
 *
 * Every field is validated here rather than at the point of use, so an adapter
 * that starts running has already proved its inputs are the ones the gate
 * documents. Paths are NOT realpath'd — the gate compares the certificate's
 * `appRoot`/`baselineRoot` with `path.resolve` against the values it passed
 * (`:459-460`), so echoing back a realpath'd path would fail the comparison on
 * any machine where the case directory sits under a symlink.
 *
 * @param argv Arguments after the script path (`process.argv.slice(2)`).
 * @returns The parsed, validated options.
 */
export function parseOracleArguments(argv) {
  const raw = {};
  let mutationControl = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === "--mutation-control") {
      mutationControl = true;
      continue;
    }

    const key = VALUE_FLAGS.get(flag);

    if (!key) {
      throw new Error(`Unrecognised oracle argument: ${flag}`);
    }

    const value = argv[index + 1];

    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }

    raw[key] = value;
    index += 1;
  }

  for (const [flag, key] of VALUE_FLAGS) {
    if (!raw[key]) {
      throw new Error(`${flag} is required`);
    }
  }

  if (raw.format !== "json") {
    throw new Error(`Unsupported --format: ${raw.format}`);
  }

  if (!EXACT_VERSION.test(raw.candidateVersion)) {
    throw new Error(`--candidate-version must be an exact semver: ${raw.candidateVersion}`);
  }

  let features;

  try {
    features = JSON.parse(raw.featuresJson);
  } catch (error) {
    throw new Error(`--features-json is not valid JSON: ${String(error)}`);
  }

  if (!Array.isArray(features) || features.some(feature => typeof feature !== "string")) {
    throw new Error("--features-json must be a JSON array of strings");
  }

  return {
    appRoot: raw.appRoot,
    baselineRoot: raw.baselineRoot,
    features,
    candidateVersion: raw.candidateVersion,
    mutationControl,
  };
}

/**
 * Resolve a path that must already exist, failing loudly when it does not.
 *
 * @param label Human name of the argument, used in the error.
 * @param value The path to check.
 * @returns The path, unchanged, once its existence is proved.
 */
export async function assertExistingDirectory(label, value) {
  try {
    await realpath(value);
  } catch {
    throw new Error(`${label} does not exist: ${value}`);
  }

  return value;
}
