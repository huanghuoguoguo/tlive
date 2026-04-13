#!/bin/bash
# TLive installer script
# Usage: curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash

set -e

REPO="huanghuoguoguo/tlive"
INSTALL_DIR="${TLIVE_HOME:-$HOME/.tlive}"
APP_DIR="${INSTALL_DIR}/app"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check Node.js >= 20
check_node() {
    if ! command -v node &>/dev/null; then
        error "Node.js is required but not installed. Install Node.js 20+ first: https://nodejs.org"
    fi
    local node_major
    node_major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$node_major" -lt 20 ]; then
        error "Node.js 20+ is required (found v$(node -p process.version))"
    fi
    info "Node.js $(node -p process.version) ✓"
}

get_latest_version() {
    local version
    version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$version" ]; then
        error "Failed to get latest version"
    fi
    echo "$version"
}

main() {
    echo ""
    echo "  ╔═══════════════════════════════════════╗"
    echo "  ║       TLive Installer                 ║"
    echo "  ╚═══════════════════════════════════════╝"
    echo ""

    check_node

    # Determine version
    local version
    if [ -n "$1" ]; then
        version="$1"
    else
        version=$(get_latest_version)
    fi
    if [[ ! "$version" =~ ^v ]]; then
        version="v${version}"
    fi
    info "Version: ${version}"

    # Download tarball
    local download_url="https://github.com/${REPO}/releases/download/${version}/tlive-${version}.tar.gz"
    local tmp_dir
    tmp_dir=$(mktemp -d)
    local tarball="${tmp_dir}/tlive.tar.gz"
    local staged_dir="${tmp_dir}/app"
    local backup_dir=""

    info "Downloading tlive ${version}..."
    if ! curl -fsSL "$download_url" -o "$tarball"; then
        error "Failed to download from ${download_url}"
    fi

    # Extract to staging directory first so the existing install stays intact on failure
    info "Preparing staged install..."
    mkdir -p "$staged_dir"
    tar xzf "$tarball" -C "$staged_dir"

    # Install production dependencies
    info "Installing dependencies..."
    cd "${staged_dir}"
    npm ci --production --ignore-scripts 2>/dev/null || npm install --production --ignore-scripts 2>/dev/null
    if [ -f "scripts/postinstall.js" ]; then
        info "Running tlive postinstall..."
        node scripts/postinstall.js
    fi
    cd - >/dev/null

    info "Installing to ${APP_DIR}..."
    if [ -d "$APP_DIR" ]; then
        backup_dir="${INSTALL_DIR}/app-backup-$(date +%s)"
        mv "$APP_DIR" "$backup_dir"
    fi
    if ! mv "$staged_dir" "$APP_DIR"; then
        if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
            mv "$backup_dir" "$APP_DIR"
        fi
        error "Failed to activate ${version}"
    fi

    # Create wrapper script
    local bin_dir="${HOME}/.local/bin"
    mkdir -p "$bin_dir"
    cat > "${bin_dir}/tlive" << 'WRAPPER'
#!/bin/bash
exec node "${TLIVE_HOME:-$HOME/.tlive}/app/scripts/cli.js" "$@"
WRAPPER
    chmod +x "${bin_dir}/tlive"
    info "Created ${bin_dir}/tlive"

    # Check PATH
    if ! echo "$PATH" | grep -q "$bin_dir"; then
        warn "${bin_dir} is not in your PATH"
        echo ""
        echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo "    export PATH=\"\${PATH}:${bin_dir}\""
        echo ""
    fi

    # Cleanup
    rm -rf "$tmp_dir"

    echo ""
    info "Installation complete! Run 'tlive --help' to get started."
    if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
        info "Previous version backed up to ${backup_dir}"
    fi
    echo ""
}

main "$@"
