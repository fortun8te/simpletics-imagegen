#!/bin/sh
# tools/ocrjson/build.sh — build the S1 OCR CLI (Apple Vision) into bin/ocrjson.
# Called manually and by lib/ocr.mjs when the binary is missing and swiftc exists.
# Must be run from the studio root, or anywhere: paths are resolved from this script.
set -e
STUDIO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$STUDIO/bin"
/usr/bin/swiftc -O "$STUDIO/tools/ocrjson/main.swift" -o "$STUDIO/bin/ocrjson"
echo "built $STUDIO/bin/ocrjson" >&2
