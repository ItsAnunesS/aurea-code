#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# linuxdeploy forwards this to appimagetool, embedding the Gear Lever source.
export UPDATE_INFORMATION='gh-releases-zsync|ItsAnunesS|aurea-code|latest|Aurea-Code-*-x86_64.AppImage.zsync'
export APPIMAGE_EXTRACT_AND_RUN=1
command -v zsyncmake >/dev/null || { echo 'Install zsync before packaging.' >&2; exit 1; }
npm run tauri -- build --bundles appimage --ci -- --locked
version=$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
mkdir -p artifacts
mapfile -d '' bundles < <(find src-tauri/target/release/bundle/appimage -maxdepth 1 -name "*_${version}_amd64.AppImage" -print0)
[[ ${#bundles[@]} -eq 1 ]] || { echo 'Expected exactly one x86_64 AppImage for this version.' >&2; exit 1; }
name="Aurea-Code-${version}-x86_64.AppImage"
cp "${bundles[0]}" "artifacts/$name"
chmod +x "artifacts/$name"
actual=$(env -u APPIMAGE_EXTRACT_AND_RUN "artifacts/$name" --appimage-updateinformation)
[[ "$actual" == "$UPDATE_INFORMATION" ]] || { echo 'AppImage update metadata is missing or incorrect.' >&2; exit 1; }
(
  cd artifacts
  zsyncmake -u "https://github.com/ItsAnunesS/aurea-code/releases/download/v${version}/${name}" -o "${name}.zsync" "$name"
  sha256sum "$name" "${name}.zsync" > SHA256SUMS-linux.txt
)
python3 scripts/verify-appimage.py "artifacts/$name"
