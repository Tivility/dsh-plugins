#!/usr/bin/env bash
# Let .github/workflows/publish.yml publish packages: create each package's npm
# trusted-publisher configuration for this repository's workflow.
#
#   scripts/trust.sh <package dir under packages/>...
#   scripts/trust.sh tool-subagent-memory tool-workflow-memory
#
# Run it in a maintainer's terminal. npm requires an interactive login and
# approves the first `npm trust` call with two-factor authentication; tick the
# option there to skip two-factor authentication for five minutes, and the
# remaining packages are configured without another prompt.
#
# Configure a package only when its next version is ready: a configuration
# expires unless a publish through it succeeds within two days. Each package
# has its own configuration; npm has no account- or scope-wide one.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo 'usage: scripts/trust.sh <package dir under packages/>...' >&2
  exit 2
fi
cd "$(dirname "$0")/.."

# `npm trust --allow-publish` needs npm 11.15.0.
npm_cli=(npx --yes npm@^11.15.0)

names=()
for package in "$@"; do
  if [ ! -f "packages/$package/package.json" ]; then
    echo "trust.sh: no package at packages/$package" >&2
    exit 2
  fi
  names+=("$(node -p "require('./packages/$package/package.json').name")")
done

if ! "${npm_cli[@]}" whoami >/dev/null 2>&1; then
  "${npm_cli[@]}" login
fi

failed=0
for name in "${names[@]}"; do
  if "${npm_cli[@]}" trust github "$name" --file publish.yml --repository Tivility/dsh-plugins --allow-publish --yes; then
    echo "trust.sh: $name trusts Tivility/dsh-plugins publish.yml"
  else
    echo "trust.sh: $name was not configured (an existing configuration is listed by: npm trust list $name)" >&2
    failed=1
  fi
  # npm asks bulk callers to pace requests.
  sleep 2
done
exit "$failed"
