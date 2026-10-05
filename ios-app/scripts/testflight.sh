#!/bin/sh
# The app on TestFlight: generates the project, archives it signed for the App
# Store and uploads it to App Store Connect, where it shows in TestFlight once
# processed (10 to 30 minutes).
#
#   scripts/testflight.sh               # archive and upload
#   scripts/testflight.sh --no-upload   # archive and export an .ipa to build/export only
#
# Signing is automatic, for HUSH_TEAM (bavrk's team by default): Xcode makes the
# distribution certificate and profile when they are missing. It signs in with
# an App Store Connect API key when ASC_KEY_ID and ASC_ISSUER_ID are set, the key
# at ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (role App Manager);
# otherwise with the Apple ID Xcode is signed in with. The app must exist in App
# Store Connect (bundle ID com.bavrk.hush) before the first upload.
set -e
cd "$(dirname "$0")/.."
TEAM=${HUSH_TEAM:-DGUZG76BA2}
# A new build number every run (App Store Connect refuses one it has had): the date and time, in minutes.
BUILD=$(date +%y%m%d%H%M)
OUT=build
DESTINATION=upload
[ "$1" = "--no-upload" ] && DESTINATION=export

# The app's own hush (Config/App.xcconfig): the prod write key, from HUSH_KEY,
# or the file kept outside the repository. Without it the build sends nothing.
HUSH_ENV="$HOME/.config/hush/hush-ios.env"
if [ -z "$HUSH_KEY" ] && [ -f "$HUSH_ENV" ]; then
  HUSH_KEY=$(sed -nE 's/^HUSH_KEY_PROD="(.*)"$/\1/p' "$HUSH_ENV")
fi
[ -n "$HUSH_KEY" ] || echo "No HUSH_KEY: this build will not report its own usage or take feedback." >&2

AUTH=""
if [ -n "$ASC_KEY_ID" ] && [ -n "$ASC_ISSUER_ID" ]; then
  KEY="$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8"
  [ -f "$KEY" ] || { echo "No API key at $KEY" >&2; exit 1; }
  AUTH="-authenticationKeyPath $KEY -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
fi

xcodegen generate --quiet
rm -rf "$OUT"
mkdir -p "$OUT"
xcodebuild -quiet -project Hush.xcodeproj -scheme Hush -configuration Release \
  -destination generic/platform=iOS -archivePath "$OUT/Hush.xcarchive" -allowProvisioningUpdates $AUTH \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD" HUSH_KEY="$HUSH_KEY" archive

cat > "$OUT/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DESTINATION</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
xcodebuild -quiet -exportArchive -archivePath "$OUT/Hush.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/export.plist" -allowProvisioningUpdates $AUTH

if [ "$DESTINATION" = upload ]; then
  echo "Build $BUILD uploaded: it shows in App Store Connect > TestFlight once processed."
else
  echo "Build $BUILD exported: $OUT/export"
fi
