#!/usr/bin/env bash
# Build, sign and notarise the macOS dmg (arm64).
# Prerequisites: a "Developer ID Application" identity in the keychain, and
# APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID in the environment.
#
# Everything here is electron-builder's own flow. The one addition is a patch to
# @electron/notarize, which this product name breaks:
#
#   Before notarising, it verifies the signature by running codesign with the
#   *bare basename* of the bundle and cwd set to the parent directory. Our
#   bundle is "6502 KIMulator.app", and codesign reads a leading-digit operand
#   as a PID — so it goes looking for process 6502, gets ESRCH, and reports
#   "6502 KIMulator.app: No such process". The build then dies after signing but
#   before notarisation, with a signature that is in fact perfectly valid.
#
#   Prefixing "./" makes the operand unambiguously a path. Verified: bare
#   "6502 KIMulator.app" fails, "./6502 KIMulator.app" succeeds, and a bundle
#   renamed to start with a letter succeeds either way.
#
# node_modules is not ours to keep, so this reapplies on every build and is a
# no-op once patched. dist-win.sh reaches into node_modules for its own reason.
set -euo pipefail

CHECK="node_modules/@electron/notarize/lib/check-signature.js"

if [ ! -f "$CHECK" ]; then
  echo "error: $CHECK not found — run npm ci first" >&2
  exit 1
fi

if grep -q "'\./' + path.basename(opts.appPath)" "$CHECK"; then
  echo "• @electron/notarize already patched for the leading-digit bundle name"
else
  sed -i '' "s|path\.basename(opts\.appPath)|'./' + path.basename(opts.appPath)|g" "$CHECK"
  echo "• patched @electron/notarize for the leading-digit bundle name"
fi

npx electron-builder --mac
