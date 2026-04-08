#!/bin/bash
# One-click installer helper for the GitHub fork
set -e

echo "=== TermLive Installer ==="
echo ""

TERMLIVE_HOME="$HOME/.tlive"
mkdir -p "$TERMLIVE_HOME/bin"

# 1. Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)       ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "ERROR: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "Platform: ${OS}-${ARCH}"

# 2. Download Go Core binary
GITHUB_REPO="huanghuoguoguo/tlive"
VERSION=$(curl -sf https://api.github.com/repos/${GITHUB_REPO}/releases/latest | grep -o '"tag_name": "[^"]*"' | cut -d'"' -f4 || echo "latest")

BINARY_URL="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/tlive-${OS}-${ARCH}"
DEST="$TERMLIVE_HOME/bin/tlive"

echo "Downloading tlive ${VERSION}..."
curl -fSL "$BINARY_URL" -o "$DEST"
chmod +x "$DEST"
echo "Go Core installed: $DEST"

# 3. Check Node.js
if ! command -v node &>/dev/null; then
  echo ""
  echo "WARNING: Node.js is required for the Bridge (IM integration)."
  echo "Install from https://nodejs.org/, then build this fork from source if you need IM Bridge features."
  echo ""
  echo "Go Core is ready. You can use it standalone:"
  echo "  $DEST daemon --port 8080"
  exit 0
fi

echo "Node.js found: $(node -v)"

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "  1. This fork is not published to npm"
echo "  2. For IM Bridge/setup commands, clone and build from source:"
echo "     git clone https://github.com/huanghuoguoguo/tlive.git"
echo "     cd tlive && npm install && npm run build"
echo "  3. Or in Claude Code, use the repo-local /tlive setup flow"
echo ""
