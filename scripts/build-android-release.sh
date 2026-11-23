#!/usr/bin/env bash
# Build a signed production APK for net.ankio.qqpet.
#
# Signing inputs (either):
#   1. ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD
#      (CI uses this), or
#   2. android/keystore.properties (gitignored, chmod 600) with storeFile/storePassword/
#      keyAlias/keyPassword for local builds.
# The local canonical copy lives at ~/.qqpet-release/ and is loaded by default.
#
# The APK is written to android/app/build/outputs/apk/release/app-release.apk.
# No build artifacts are uploaded by this script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${QQPET_RELEASE_ENV:-$HOME/.qqpet-release/release.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ -z "${ANDROID_KEYSTORE:-}" ] && [ ! -f "$ROOT/android/keystore.properties" ]; then
  echo "error: release signing is not configured." >&2
  echo "  set ANDROID_KEYSTORE/ANDROID_KEYSTORE_PASSWORD/ANDROID_KEY_ALIAS/ANDROID_KEY_PASSWORD" >&2
  echo "  or create android/keystore.properties (gitignored) with storeFile/storePassword/keyAlias/keyPassword." >&2
  exit 1
fi

# Prefer a Java 17 JDK. /usr/libexec/java_home can return an older JDK when no 17
# is registered, so verify the candidate and fall back to the running java.
JDK17="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
if [ -z "$JDK17" ] || ! "$JDK17/bin/java" -version 2>&1 | grep -q 'version "17'; then
  JDK17="$(java -XshowSettings:properties -version 2>&1 | awk -F'= ' '/^    java.home =/{print $2; exit}')"
fi
if [ -z "$JDK17" ] || ! "$JDK17/bin/java" -version 2>&1 | grep -q 'version "17'; then
  echo "error: Java 17 not found; install a JDK 17 and set JAVA_HOME." >&2
  exit 1
fi
export JAVA_HOME="$JDK17"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ ! -d "$SDK" ] && [ -d /opt/homebrew/share/android-commandlinetools ]; then
  SDK=/opt/homebrew/share/android-commandlinetools
fi
if [ ! -d "$SDK" ]; then
  echo "error: Android SDK not found; set ANDROID_HOME." >&2
  exit 1
fi
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

if [ ! -f "$ROOT/android/local.properties" ]; then
  printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$ROOT/android/local.properties"
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"
echo "building qqpet $VERSION (release)"
cd "$ROOT"
QQPET_VERSION="$VERSION" npm run build:android-web
cd "$ROOT/android"
./gradlew assembleRelease

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
APKSIGNER="$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$APK" | head -8
else
  echo "warning: apksigner not found under $ANDROID_HOME/build-tools" >&2
fi
shasum -a 256 "$APK"
echo "APK: $APK"
