#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "Build Agnostr.app on macOS." >&2; exit 1; }
ARCH="${AGNOSTR_MAC_ARCH:-$(uname -m)}"
case "$ARCH" in arm64|x86_64) ;; *) echo "Unknown macOS architecture: $ARCH" >&2; exit 2 ;; esac

npm run build:mac-web
stage="$(mktemp -d "${TMPDIR:-/tmp}/agnostr-mac.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/Agnostr.app/Contents/"{MacOS,Resources} dist-mac
app="$stage/Agnostr.app"
cp macos/Info.plist "$app/Contents/"
if [[ -n "${AGNOSTR_MAC_BUILD_NUMBER:-}" ]]; then
  plutil -replace CFBundleVersion -string "$AGNOSTR_MAC_BUILD_NUMBER" "$app/Contents/Info.plist"
fi
ditto dist-macos "$app/Contents/Resources/web"
mkdir "$stage/Agnostr.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" public/icon-512.png --out "$stage/Agnostr.iconset/icon_${size}x${size}.png" >/dev/null
  if [[ "$size" -lt 512 ]]; then
    double="$((size * 2))"
    sips -z "$double" "$double" public/icon-512.png --out "$stage/Agnostr.iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$stage/Agnostr.iconset" -o "$app/Contents/Resources/Agnostr.icns"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -O -sdk "$SDK" -target "${ARCH}-apple-macos13.0" macos/*.swift -o "$app/Contents/MacOS/Agnostr"
codesign --force --options runtime --sign "${AGNOSTR_MAC_SIGN_IDENTITY:--}" "$app"
codesign --verify --deep --strict "$app"
if [[ "${1:-}" == "--smoke-test" ]]; then "$app/Contents/MacOS/Agnostr" --smoke-test; fi
if [[ -d dist-mac/Agnostr.app ]]; then rm -rf dist-mac/Agnostr.app; fi
ditto "$app" dist-mac/Agnostr.app
zip="dist-mac/Agnostr-macOS-${ARCH}.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
shasum -a 256 "$zip"
printf 'App: %s/dist-mac/Agnostr.app\nArchive: %s/%s\n' "$PWD" "$PWD" "$zip"
