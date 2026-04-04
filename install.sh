#!/bin/bash
# TLive installer script
# Usage: curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash

set -e

REPO="huanghuoguoguo/tlive"
BINARY_NAME="tlive"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*)    echo "darwin" ;;
        Linux*)     echo "linux" ;;
        CYGWIN*|MINGW*|MSYS*)    echo "windows" ;;
        *)          error "Unsupported OS: $(uname -s)" ;;
    esac
}

# Detect architecture
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)    echo "amd64" ;;
        arm64|aarch64)   echo "arm64" ;;
        *)               error "Unsupported architecture: $(uname -m)" ;;
    esac
}

# Get latest release version
get_latest_version() {
    local version
    version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$version" ]; then
        error "Failed to get latest version"
    fi
    echo "$version"
}

# Download binary
download_binary() {
    local os="$1"
    local arch="$2"
    local version="$3"
    local ext=""

    if [ "$os" = "windows" ]; then
        ext=".exe"
    fi

    local download_url="https://github.com/${REPO}/releases/download/${version}/${BINARY_NAME}-${os}-${arch}${ext}"
    local tmp_dir=$(mktemp -d)
    local tmp_file="${tmp_dir}/${BINARY_NAME}${ext}"

    info "Downloading ${BINARY_NAME} ${version} for ${os}/${arch}..."

    if ! curl -fsSL "$download_url" -o "$tmp_file"; then
        error "Failed to download from ${download_url}"
    fi

    echo "$tmp_file"
}

# Install binary
install_binary() {
    local tmp_file="$1"
    local install_dir="$2"
    local binary_name=$(basename "$tmp_file")

    chmod +x "$tmp_file"

    if [ -w "$install_dir" ]; then
        mv "$tmp_file" "${install_dir}/${binary_name}"
        info "Installed ${binary_name} to ${install_dir}"
    else
        warn "No write permission for ${install_dir}, trying with sudo..."
        sudo mv "$tmp_file" "${install_dir}/${binary_name}"
        info "Installed ${binary_name} to ${install_dir} (with sudo)"
    fi
}

# Check if directory is in PATH
check_path() {
    local dir="$1"
    if echo "$PATH" | grep -q "$dir"; then
        return 0
    else
        return 1
    fi
}

main() {
    echo ""
    echo "  ╔═══════════════════════════════════════╗"
    echo "  ║       TLive Installer                 ║"
    echo "  ╚═══════════════════════════════════════╝"
    echo ""

    # Detect system
    local os=$(detect_os)
    local arch=$(detect_arch)
    info "Detected: ${os}/${arch}"

    # Get version
    local version
    if [ -n "$1" ]; then
        version="$1"
    else
        version=$(get_latest_version)
    fi
    info "Version: ${version}"

    # Determine install directory
    local install_dir="/usr/local/bin"
    if [ ! -w "$install_dir" ] && [ -z "$SUDO_USER" ]; then
        # Try ~/.local/bin if /usr/local/bin is not writable
        install_dir="${HOME}/.local/bin"
        mkdir -p "$install_dir"
    fi

    # Download
    local tmp_file=$(download_binary "$os" "$arch" "$version")

    # Install
    install_binary "$tmp_file" "$install_dir"

    # Check PATH
    if ! check_path "$install_dir"; then
        warn "${install_dir} is not in your PATH"
        echo ""
        echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo ""
        echo "    export PATH=\"\${PATH}:${install_dir}\""
        echo ""
    fi

    # Cleanup
    rm -rf "$(dirname "$tmp_file")"

    echo ""
    info "Installation complete! Run 'tlive --help' to get started."
    echo ""
}

main "$@"