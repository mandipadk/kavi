#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET_PATH="${TARGET_DIR}/kavi"

mkdir -p "${TARGET_DIR}"
ln -sf "${ROOT_DIR}/bin/kavi.js" "${TARGET_PATH}"
chmod +x "${ROOT_DIR}/bin/kavi.js"

echo "Installed kavi to ${TARGET_PATH}"
echo "Make sure ${TARGET_DIR} is on your PATH."
