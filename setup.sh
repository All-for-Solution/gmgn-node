#!/usr/bin/env bash
# Installs the system pieces this node needs on a fresh Debian/Ubuntu machine:
# Google Chrome (Playwright channel "chrome"), Xvfb, npm packages, and a .env
# if one is not already present. The app starts Xvfb itself on :95.
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash setup.sh" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script needs apt-get (Debian or Ubuntu)." >&2
  exit 1
fi

arch="$(dpkg --print-architecture)"
if [[ "$arch" != "amd64" ]]; then
  echo "Google Chrome's package is amd64 only. This machine is ${arch}." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg xvfb

if [[ ! -f /usr/share/keyrings/google-chrome.gpg ]]; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  chmod 0644 /usr/share/keyrings/google-chrome.gpg
fi

if [[ ! -f /etc/apt/sources.list.d/google-chrome.sources && ! -f /etc/apt/sources.list.d/google-chrome.list ]]; then
  cat > /etc/apt/sources.list.d/google-chrome.sources << 'EOF'
Types: deb
URIs: https://dl.google.com/linux/chrome-stable/deb/
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/google-chrome.gpg
EOF
  apt-get update
fi

apt-get install -y google-chrome-stable xvfb

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 18+ is not on PATH. Install Node 22, then run this script again." >&2
  exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" -lt 18 ]]; then
  echo "Node.js 18+ is required. Current version is $(node -v)." >&2
  exit 1
fi

npm install

if [[ ! -f .env ]]; then
  cat > .env << 'EOF'
PORT=4400
GMGN_WINDOWS=3
GMGN_GAP_MS=120
GMGN_NODE_SECRET=replace-with-a-long-secret
EOF
  echo "Created .env. Set GMGN_NODE_SECRET before starting."
fi

test -x /opt/google/chrome/chrome
command -v Xvfb >/dev/null

echo
echo "Ready."
echo "  npm start"
echo "Chrome profile is stored in session/chrome-profile."
echo "Log into GMGN once in that window; later starts reuse the same profile."
