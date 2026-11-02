#!/usr/bin/env bash
# Build, test, pack, and publish one package from packages/.
#
#   scripts/publish.sh <package dir> <dist-tag> [--dry-run]
#   scripts/publish.sh tool-subagent-memory latest --dry-run
#
# .github/workflows/publish.yml runs this with npm trusted publishing, so the
# registry authenticates the workflow run itself and no npm token exists
# anywhere. Locally, --dry-run rehearses the same steps without credentials.
#
# Only the named package and the workspace packages it references are built:
# the repository-wide `tsc -b` also compiles every other package, and a clean
# install of the DSH 0.1 line packages does not typecheck.
set -euo pipefail

usage='usage: scripts/publish.sh <package dir under packages/> <dist-tag> [--dry-run]'
package=${1:?$usage}
tag=${2:?$usage}
dry_run=${3:-}
if [ -n "$dry_run" ] && [ "$dry_run" != --dry-run ]; then
  echo "publish.sh: unknown option $dry_run; $usage" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
dir="packages/$package"
if [ ! -f "$dir/package.json" ]; then
  echo "publish.sh: no package at $dir" >&2
  exit 2
fi
name=$(node -p "require('./$dir/package.json').name")
version=$(node -p "require('./$dir/package.json').version")

# A 404 is the expected answer; any other failure stops here instead of later.
if view=$(npm view "$name@$version" version 2>&1); then
  if [ -n "$view" ]; then
    echo "publish.sh: $name@$version is already published" >&2
    exit 1
  fi
elif ! grep -q E404 <<<"$view"; then
  echo "publish.sh: cannot check whether $name@$version is published:" >&2
  echo "$view" >&2
  exit 1
fi

pnpm exec tsc -b "$dir"
pnpm --dir "$dir" run --if-present bundle
pnpm exec vitest run --passWithNoTests "$dir/"

out=$(mktemp -d)
# pnpm rewrites workspace: ranges to the versions being published; npm pack does not.
(cd "$dir" && pnpm pack --pack-destination "$out" >/dev/null)
tarball=$(ls "$out"/*.tgz)

echo "publish.sh: $name@$version with dist-tag $tag${dry_run:+ (dry run)}"
npm publish "$tarball" --access public --tag "$tag" ${dry_run:+--dry-run}
