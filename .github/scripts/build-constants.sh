#!/usr/bin/env bash
set -euo pipefail

# Consumers install @kasakame/constants from a file: dependency, so its dist
# build must exist before their npm ci. Run from anywhere in the checkout.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/projects/constants"
npm ci --no-audit --no-fund
npm run build
