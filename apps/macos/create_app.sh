#!/bin/bash

APP_NAME="ScreenCaptureReport"
ICON_SOURCE="app_icon.png"
ICON_SET="app_icon.iconset"

echo "Building ${APP_NAME}..."

# 1. Clean up old builds
rm -rf build dist

# 2. Handle Icons for py2app (It needs .icns file)
if [ -f "$ICON_SOURCE" ]; then
    echo "Creating icons..."
    mkdir -p "$ICON_SET"
    
    sips -z 16 16     -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_16x16.png"
    sips -z 32 32     -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_16x16@2x.png"
    sips -z 32 32     -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_32x32.png"
    sips -z 64 64     -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_32x32@2x.png"
    sips -z 128 128   -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_128x128.png"
    sips -z 256 256   -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_128x128@2x.png"
    sips -z 256 256   -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_256x256.png"
    sips -z 512 512   -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_256x256@2x.png"
    sips -z 512 512   -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_512x512.png"
    sips -z 1024 1024 -s format png "$ICON_SOURCE" --out "${ICON_SET}/icon_512x512@2x.png"

    echo "Converting to icns..."
    iconutil -c icns "$ICON_SET" -o "app_icon.icns"
    
    rm -rf "$ICON_SET"
else
    echo "Warning: No icon found at $ICON_SOURCE"
fi

# 3. Build with py2app
# We use alias mode (-A) for dev speed, or full build without it.
# For distribution/reliability, let's do a full build (no -A) to ensure all libs are packed.
# However, -A is faster for iterating.
# Given the user wants to solve permission issues, a full build is cleaner as it isolates the env.

echo "Running py2app..."
python setup.py py2app

# 4. Cleanup
# rm app_icon.icns (Keep it maybe?)

echo "Done! App is in ./dist/${APP_NAME}.app"
