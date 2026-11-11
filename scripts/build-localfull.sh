#!/bin/sh
# The Mac builds of the server for `local --full` (SPEC REQ-F-901): darwin-arm64 and darwin-amd64, with the web
# screen and the server's own files inside (-tags localfull). Run only by the Dockerfile's `localfull` stage, so the
# image and the maintainer's Mac (scripts/sign-agent.mjs builds that same stage) make them from the same Go, the same
# web screen build and these same steps: the bytes the maintainer signs are the bytes the image makes.
#   sh scripts/build-localfull.sh <repository folder> <ui/dist folder> <out folder>
set -eu
SRC=$1
DIST=$2
OUT=$3
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/b/fullroot/ui" "$W/b/fullroot/server" "$OUT"
for f in "$SRC"/server/*.go; do
  case "$f" in
  *_test.go) ;;
  *) cp "$f" "$W/b/" ;;
  esac
done
cp "$SRC/server/go.mod" "$W/b/"
if [ -f "$SRC/server/go.sum" ]; then cp "$SRC/server/go.sum" "$W/b/"; fi
cp -R "$DIST" "$W/b/fullroot/ui/dist"
cp -R "$SRC/web" "$W/b/fullroot/web"
cp "$SRC/package.json" "$W/b/fullroot/"
cp "$SRC/server/quality.json" "$SRC/server/skills.go" "$W/b/fullroot/server/"
# A Finder's .DS_Store or an editor's leftovers in a working copy must not make a different build than a clean clone.
find "$W/b/fullroot" -name '.*' -type f -exec rm -f {} +
cd "$W/b"
for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -tags localfull -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "$OUT/darwin-$arch" .
done
