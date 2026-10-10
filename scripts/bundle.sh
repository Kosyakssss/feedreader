#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -n 1)
dest=${1:-"$HOME/Applications"}

cargo build --release --manifest-path "$root/Cargo.toml" -p feedreader

app="$root/target/Feedreader.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$root/target/release/feedreader" "$app/Contents/MacOS/feedreader"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Feedreader</string>
  <key>CFBundleDisplayName</key><string>Feedreader</string>
  <key>CFBundleIdentifier</key><string>app.feedreader</string>
  <key>CFBundleExecutable</key><string>feedreader</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.news</string>
</dict>
</plist>
EOF

codesign --force --sign - "$app" >/dev/null 2>&1 || true

mkdir -p "$dest"
rm -rf "$dest/Feedreader.app"
cp -R "$app" "$dest/Feedreader.app"

mkdir -p "$HOME/.local/bin"
ln -sf "$dest/Feedreader.app/Contents/MacOS/feedreader" "$HOME/.local/bin/feedreader"

echo "Installed $dest/Feedreader.app (version $version) and linked ~/.local/bin/feedreader to it."
