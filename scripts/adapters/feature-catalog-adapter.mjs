#!/usr/bin/env node
/**
 * WARLOCK_FEATURE_CATALOG_ADAPTER
 *
 * Invoked by the zero-edit generator gate as a plain child process:
 *
 *   node feature-catalog-adapter.mjs --core-root <coreRoot> --format json
 *
 * It must enumerate the generator features from the INSTALLED Core's own
 * feature map — not from any list kept in this repo — and print a
 * FeatureCatalog JSON object to stdout. `@warlock.js/core`'s published
 * `exports` map has no subpath for `generations/*`, so the feature map is
 * reached by dynamic-importing the compiled file by absolute path, which
 * Node permits for direct file URLs even outside the exports allowlist:
 *
 *   <coreRoot>/esm/generations/add-command.action.mjs
 *
 * `add-command.action.mjs` imports `featuresMap` from a sibling module but,
 * in the real published 5.3.2 tarball, does not itself re-export it — only
 * `addCommandAction` is exported there. The map itself is exported one level
 * down, from:
 *
 *   <coreRoot>/esm/generations/features/index.mjs
 *
 * which is what this adapter actually imports. (An out-of-band local build
 * under builder/builds/@warlock.js/core/5.3.2 does re-export `featuresMap`
 * from add-command.action.mjs directly, but that build has never been
 * published — the installed tarball is the ground truth and is what this
 * adapter is verified against.) The keys are the same kebab-case feature
 * names `warlock add` and `warlock add --list` accept.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--core-root") {
      args.coreRoot = argv[index + 1];
      index += 1;
    } else if (flag === "--format") {
      args.format = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.coreRoot) {
    throw new Error("--core-root is required");
  }
  if (args.format !== "json") {
    throw new Error(`Unsupported --format: ${String(args.format)}`);
  }

  const coreRoot = await realpath(args.coreRoot);
  const featuresModulePath = path.join(
    coreRoot,
    "esm",
    "generations",
    "features",
    "index.mjs",
  );
  const featuresModule = await import(pathToFileURL(featuresModulePath).href);

  const featuresMap = featuresModule.featuresMap;
  if (!featuresMap || typeof featuresMap !== "object") {
    throw new Error(`No featuresMap export found at ${featuresModulePath}`);
  }

  const features = Object.keys(featuresMap);
  if (features.length === 0) {
    throw new Error("Installed Core feature map produced no top-level features.");
  }

  const catalog = {
    schemaVersion: 1,
    source: "installed-core-feature-map",
    coreRoot,
    complete: true,
    features,
  };

  process.stdout.write(`${JSON.stringify(catalog)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
