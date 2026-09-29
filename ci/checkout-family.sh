#!/usr/bin/env bash
# Rebuilds the local workspace layout on a CI runner:
#
#   $WS/builder          this repo (already checked out by the workflow)
#   $WS/<member>         one full clone per family member, derived from pkgist.config.ts
#   $WS/docs             warlockjs/documentation (a workspace project, not a member)
#   $BLOG_DIR            warlockjs/blog-test (private; the release's blog check)
#
# Clones are FULL (history + tags): `confirm` needs real history for
# `git merge-base --is-ancestor` and pushes the recorded release commit.
#
# The token is passed per command through GIT_CONFIG_* env and never written
# to .git/config, so the remotes stay plain https URLs and nothing later in
# the job (package tests included) can read the credential from disk.
set -euo pipefail

: "${WS:?WS must point at the workspace root}"
: "${BLOG_DIR:?BLOG_DIR must be set}"
: "${GH_TOKEN:?GH_TOKEN must be set (RELEASE_GH_TOKEN)}"

export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.https://x-access-token:${GH_TOKEN}@github.com/.insteadOf"
export GIT_CONFIG_VALUE_0="https://github.com/"

members=$(grep -oE 'root: "\.\./[a-z0-9-]+"' "$WS/builder/pkgist.config.ts" | sed -E 's/.*\.\.\/([a-z0-9-]+)"/\1/' | sort -u)
count=$(printf '%s\n' "$members" | grep -c .)
if [ "$count" -ne 31 ]; then
  echo "::error::expected 31 family members in pkgist.config.ts, found $count" >&2
  exit 1
fi

clone() {
  local repo="$1" dir="$2"
  echo "clone warlockjs/$repo -> $dir"
  git clone --quiet --branch main "https://github.com/warlockjs/$repo.git" "$dir"
}

for name in $members; do
  clone "$name" "$WS/$name"
done
clone documentation "$WS/docs"
clone blog-test "$BLOG_DIR"

# One line per repo for the job summary: what exactly was gated.
{
  echo "| repo | commit |"
  echo "|---|---|"
  for name in $members docs; do
    echo "| $name | \`$(git -C "$WS/$name" rev-parse --short HEAD)\` |"
  done
  echo "| blog-test | \`$(git -C "$BLOG_DIR" rev-parse --short HEAD)\` |"
} > "$RUNNER_TEMP/checked-out.md"
