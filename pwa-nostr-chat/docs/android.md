# Agnostr for Android

The Android build packages the same React app in a Capacitor WebView. It uses
Android 7.0+ (API 24), targets API 36, and has the stable release package ID
`com.agnostr.app`. The WebView loads a bundled local web app rather than a remote
site. PWA install/updates and Web Push are intentionally disabled inside the
APK; they continue to work in the browser. Bluetooth, native background push,
and live updates are not part of this first APK. The web app and APK do not
automatically share local browser data or wallet keys.

## Toolchain and builds

Use Node 22+ (Node 24 in CI), JDK 21, and the Android command-line tools or
Android Studio. Install `platforms;android-36`, `build-tools;36.0.0` and
`platform-tools` with SDK Manager. Set `ANDROID_HOME` on nonstandard setups;
on macOS the script defaults to `~/Library/Android/sdk`.

From `pwa-nostr-chat`:

```sh
npm ci
npm run android:apk -- debug
```

The debug package uses `com.agnostr.app.debug`, so it cannot replace the
release. The same command is used by the Android APK workflow. The Gradle
wrapper is pinned and verifies the Gradle distribution checksum.

## Signed sideload releases

Store the release key, its backup and its password safely outside the checkout.
Never commit signing keys, password files, or local signing settings. Supply
paths to a release keystore and a private file containing the keystore password:

```sh
export AGNOSTR_ANDROID_KEYSTORE="$HOME/.config/agnostr/android-signing/agnostr-release.p12"
export AGNOSTR_ANDROID_KEY_PASSWORD_FILE="$HOME/.config/agnostr/android-signing/store-password"
npm run android:apk -- release
```

The expected key alias is `agnostr` (override with `AGNOSTR_ANDROID_KEY_ALIAS`).
The script aligns the APK, signs it, verifies the signature and writes the APK
and a SHA-256 file to `dist-apk/`. For later sideload releases, use the same key
and package ID and explicitly increment `AGNOSTR_ANDROID_VERSION_CODE`; set
`AGNOSTR_ANDROID_VERSION_NAME` to the corresponding display version. Do not
switch signing keys between releases. A debug build from CI is not an update
for a release installation. The release APK still needs the user's ordinary
Android install confirmation.
