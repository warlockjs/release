export function collectArtifactEntryPoints(manifest: Record<string, unknown>): Set<string>;

export function assertArtifactContainsItsEntryPoints(
  manifest: Record<string, unknown>,
  entries: Iterable<string>,
  name: string,
): void;
