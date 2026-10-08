#!/bin/sh
# build/icon.svg -> build/icon.png (1024) -> build/icon.icns, with only macOS tools.
set -e
cd "$(dirname "$0")"
rm -rf icon.iconset tmp && mkdir -p icon.iconset tmp
qlmanage -t -s 1024 -o tmp icon.svg >/dev/null 2>&1
mv tmp/icon.svg.png icon.png && rm -rf tmp
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d icon.png --out "icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
echo "build/icon.icns $(stat -f%z icon.icns) bytes"
