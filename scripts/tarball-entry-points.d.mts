export function collectTarballEntryTargets(manifest: Record<string, unknown>): Set<string>;

export function assertTarballContainsItsEntryPoints(
  name: string,
  manifest: Record<string, unknown>,
  entryPaths: ReadonlySet<string> | Iterable<string>,
): void;
