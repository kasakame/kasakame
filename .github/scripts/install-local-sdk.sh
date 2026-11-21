#!/usr/bin/env bash
set -euo pipefail

# Run from the project directory. CI sets LOCAL_SDK when the SDK changed in the same run.
if [ "${LOCAL_SDK:-false}" = "true" ]; then
  npm install --no-save --install-links "file:../sdk"
else
  npm ci
fi
