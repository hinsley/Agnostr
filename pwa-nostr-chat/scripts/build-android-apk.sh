#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

variant="${1:-debug}"
case "$variant" in debug|release) ;; *) echo "Usage: npm run android:apk -- [debug|release]" >&2; exit 2 ;; esac
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
fi
if [[ -n "${JAVA_HOME:-}" ]]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
if ! java -version 2>&1 | grep -qE 'version "21[.]'; then
  echo 'Android build requires JDK 21 (set JAVA_HOME).' >&2; exit 1
fi
tools="$ANDROID_HOME/build-tools/36.0.0"
if [[ ! -x "$tools/apksigner" || ! -x "$tools/zipalign" || ! -r "$ANDROID_HOME/platforms/android-36/android.jar" ]]; then
  echo 'Install Android SDK platforms;android-36 and build-tools;36.0.0 with sdkmanager.' >&2; exit 1
fi

version_code="${AGNOSTR_ANDROID_VERSION_CODE:-1}"
version_name="${AGNOSTR_ANDROID_VERSION_NAME:-0.1.0-alpha.1}"
if [[ ! "$version_code" =~ ^[1-9][0-9]{0,8}$ || ! "$version_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$ ]]; then
  echo 'Invalid Android version code or name.' >&2; exit 2
fi
export AGNOSTR_ANDROID_VERSION_CODE="$version_code" AGNOSTR_ANDROID_VERSION_NAME="$version_name"

if [[ "$variant" == release ]]; then
  : "${AGNOSTR_ANDROID_KEYSTORE:?Set AGNOSTR_ANDROID_KEYSTORE to your release keystore path}"
  : "${AGNOSTR_ANDROID_KEY_PASSWORD_FILE:?Set AGNOSTR_ANDROID_KEY_PASSWORD_FILE to a private password file}"
  [[ -r "$AGNOSTR_ANDROID_KEYSTORE" && -r "$AGNOSTR_ANDROID_KEY_PASSWORD_FILE" ]] || { echo 'Release signing inputs are unreadable.' >&2; exit 1; }
fi

npm run build:android-web
[[ -s dist-android/index.html && ! -e dist-android/sw.js && ! -e dist-android/manifest.webmanifest ]]
./node_modules/.bin/cap sync android
task=assembleDebug
if [[ "$variant" == release ]]; then task=assembleRelease; fi
(cd android && ./gradlew --no-daemon --max-workers=3 "$task")
build="android/app/build/outputs/apk/$variant"
output="dist-apk/Agnostr-${version_name}-${variant}.apk"
mkdir -p dist-apk
temporary="$(mktemp -d dist-apk/.build.XXXXXX)"
trap 'rm -f -- "$temporary/aligned.apk" "$temporary/verified.apk"; rmdir "$temporary"' EXIT
verified="$temporary/verified.apk"

if [[ "$variant" == release ]]; then
  "$tools/zipalign" -P 16 -f 4 "$build/app-release-unsigned.apk" "$temporary/aligned.apk"
  "$tools/apksigner" sign --ks "$AGNOSTR_ANDROID_KEYSTORE" --ks-key-alias "${AGNOSTR_ANDROID_KEY_ALIAS:-agnostr}" \
    --ks-pass "file:$AGNOSTR_ANDROID_KEY_PASSWORD_FILE" --out "$verified" "$temporary/aligned.apk"
  rm -f -- "$verified.idsig"
else
  cp "$build/app-debug.apk" "$verified"
fi

"$tools/zipalign" -c -P 16 4 "$verified"
"$tools/apksigner" verify --verbose --print-certs "$verified"
mv -f -- "$verified" "$output"
(cd dist-apk; if command -v sha256sum >/dev/null; then sha256sum "${output##*/}"; else shasum -a 256 "${output##*/}"; fi) | tee "$output.sha256"
printf 'APK: %s/%s\n' "$PWD" "$output"
