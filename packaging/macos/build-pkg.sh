#!/bin/bash
# Builds the macOS installer: "ModelBrain RAG.pkg".
#
# Run on a Mac, from anywhere:
#   packaging/macos/build-pkg.sh
#
# The installer holds this package plus its own copy of Node.js, so the
# person installing needs nothing else. Double-clicking it:
#   1. puts the files in /Library/Application Support/ModelBrain RAG
#   2. sets the server to start when the person signs in
#   3. opens the web page, where they choose the first admin account
#
# Signing (optional, needed for other people's Macs):
#   INSTALLER_IDENTITY="Developer ID Installer: NAME (TEAMID)"
#   NOTARY_PROFILE=<the notarytool keychain profile name>
# Without INSTALLER_IDENTITY the installer is unsigned and macOS will warn.
#
# NODE_VERSION picks the Node.js release to include.

set -euo pipefail
# Installed files must be readable by every user of the Mac, whatever this
# shell's own default for new files is.
umask 022

NODE_VERSION="${NODE_VERSION:-v22.22.0}"
# The SHA-256 of node-$NODE_VERSION-darwin-arm64.tar.gz as published by the
# Node.js project. Pinned here so a tampered download fails the build. When
# you change NODE_VERSION, set NODE_SHA256 to the value from
# https://nodejs.org/dist/<version>/SHASUMS256.txt after checking that
# file's signature.
if [ "$NODE_VERSION" = "v22.22.0" ]; then
  NODE_SHA256="${NODE_SHA256:-5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640}"
fi
if [ -z "${NODE_SHA256:-}" ]; then
  echo "Set NODE_SHA256 for Node.js $NODE_VERSION (see the note in this script)." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
OUT="${OUT_DIR:-$ROOT/dist}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

INSTALL_DIR="/Library/Application Support/ModelBrain RAG"
PAYLOAD="$WORK/payload"
mkdir -p "$PAYLOAD/app" "$OUT"

echo "Copying modelbrain-rag $VERSION"
for item in bin lib package.json LICENSE README.md SECURITY.md; do
  cp -R "$ROOT/$item" "$PAYLOAD/app/"
done
cp "$HERE/uninstall.command" "$PAYLOAD/Uninstall ModelBrain RAG.command"
cp "$HERE/open.command" "$PAYLOAD/Open ModelBrain RAG.command"

echo "Fetching Node.js $NODE_VERSION"
BASE="https://nodejs.org/dist/$NODE_VERSION"
# ModelBrain on macOS needs Apple Silicon, so that is the only build included.
for arch in arm64; do
  file="node-$NODE_VERSION-darwin-$arch.tar.gz"
  curl -fsSL "$BASE/$file" -o "$WORK/$file"
  want="$NODE_SHA256"
  have="$(shasum -a 256 "$WORK/$file" | awk '{ print $1 }')"
  if [ -z "$want" ] || [ "$want" != "$have" ]; then
    echo "Checksum mismatch for $file. Stopping." >&2
    exit 1
  fi
  tar -xzf "$WORK/$file" -C "$WORK" "node-$NODE_VERSION-darwin-$arch/bin/node"
  # Kept exactly as published, so Node.js's own signature stays valid.
  cp "$WORK/node-$NODE_VERSION-darwin-$arch/bin/node" "$PAYLOAD/node-$arch"
  codesign --verify --strict "$PAYLOAD/node-$arch"
done

chmod -R u=rwX,go=rX "$WORK/payload"
chmod 755 "$PAYLOAD"/node-* "$PAYLOAD"/*.command "$PAYLOAD/app/bin/modelbrain-rag.js"

echo "Building the installer"
UNSIGNED="$WORK/unsigned.pkg"
pkgbuild --root "$WORK/payload" --identifier net.modelbrain.rag --version "$VERSION" \
  --scripts "$HERE/scripts" --install-location "$INSTALL_DIR" "$UNSIGNED"

PKG="$OUT/ModelBrain RAG $VERSION.pkg"
if [ -n "${INSTALLER_IDENTITY:-}" ]; then
  productsign --sign "$INSTALLER_IDENTITY" "$UNSIGNED" "$PKG"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$PKG"
  else
    echo "Signed but not notarized (NOTARY_PROFILE is not set)."
  fi
else
  cp "$UNSIGNED" "$PKG"
  echo "Unsigned build (INSTALLER_IDENTITY is not set). Fine for your own Mac."
fi
echo "Done: $PKG"
