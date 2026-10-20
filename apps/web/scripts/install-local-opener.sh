#!/bin/bash
# Run this on YOUR OWN Linux desktop/laptop (not on the NexusCommander LXC).
#
# It registers a `nexuscmd://` URI handler so that the "Open on this
# computer" button in NexusCommander can hand a file path straight to your
# local default app (LibreOffice, an image viewer, whatever `xdg-open` would
# normally pick). This only works for paths that exist on THIS machine too -
# typically true when your desktop mounts the same NAS shares at the same
# absolute paths as the NexusCommander LXC (see docs/TAILSCALE_STANDALONE_PLAN.md).
#
# Safe to re-run; it just overwrites its own files.

set -euo pipefail

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
HANDLER="$BIN_DIR/nexuscmd-open-handler.sh"
DESKTOP_FILE="$APP_DIR/nexuscmd-open-handler.desktop"

mkdir -p "$BIN_DIR" "$APP_DIR"

cat > "$HANDLER" <<'EOF'
#!/bin/bash
# Invoked by the desktop environment as: nexuscmd-open-handler.sh 'nexuscmd://<url-encoded-path>'
raw="${1:-}"
encoded="${raw#nexuscmd://}"
encoded="${encoded%/}"
path=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$encoded")

if [ ! -e "$path" ]; then
    notify-send "NexusCommander" "File not found on this computer: $path" 2>/dev/null || true
    exit 1
fi

xdg-open "$path"
EOF
chmod +x "$HANDLER"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=NexusCommander Local Opener
Exec=$HANDLER %u
NoDisplay=true
MimeType=x-scheme-handler/nexuscmd;
EOF

update-desktop-database "$APP_DIR" 2>/dev/null || true
xdg-mime default nexuscmd-open-handler.desktop x-scheme-handler/nexuscmd

echo "Installed. Test it with:"
echo "  xdg-open 'nexuscmd:///etc/hostname'"
