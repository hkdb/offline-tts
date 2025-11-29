#!/bin/bash
#
# Download third-party dependencies for OfflineTTS
# Run this script before loading the extension or packaging
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LIB_DIR="$PROJECT_ROOT/lib"
ONNX_DIR="$PROJECT_ROOT/assets/onnx"

# Dependency versions (update these as needed)
# Note: ONNX Runtime is now installed via npm (see package.json)
# Only model files need to be downloaded

# Hugging Face model repo
HF_REPO="Supertone/supertonic"

echo "=== OfflineTTS Dependency Downloader ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# Create directories if they don't exist
mkdir -p "$LIB_DIR"
mkdir -p "$ONNX_DIR"

# Function to download from Hugging Face
download_hf_file() {
    local repo="$1"
    local filename="$2"
    local output="$3"
    local url="https://huggingface.co/${repo}/resolve/main/${filename}"
    
    echo "  Downloading $filename..."
    if command -v curl &> /dev/null; then
        curl -sL "$url" -o "$output"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$output"
    else
        echo "Error: curl or wget is required"
        exit 1
    fi
}

echo "=== ONNX Runtime Web ==="
echo "  Installed via npm (see package.json)"
echo "  Runtime files will be copied by webpack during build"
echo ""
echo "=== Supertonic TTS Models (from Hugging Face) ==="
echo "  Source: https://huggingface.co/${HF_REPO}"
echo "  Note: These are large files (~252 MB total), please be patient..."
download_hf_file "$HF_REPO" "onnx/duration_predictor.onnx" "$ONNX_DIR/duration_predictor.onnx"
download_hf_file "$HF_REPO" "onnx/text_encoder.onnx" "$ONNX_DIR/text_encoder.onnx"
download_hf_file "$HF_REPO" "onnx/vector_estimator.onnx" "$ONNX_DIR/vector_estimator.onnx"
download_hf_file "$HF_REPO" "onnx/vocoder.onnx" "$ONNX_DIR/vocoder.onnx"
echo "  Done."

echo ""
echo "=== Download Complete ==="
echo ""
echo "ONNX models:"
ls -lh "$ONNX_DIR"/*.onnx 2>/dev/null || true
echo ""
echo "Next steps:"
echo "  1. Run 'npm install' to install dependencies (if not already done)"
echo "  2. Run 'npm run build' to build the extension with webpack"
echo "  3. Load the 'build' directory in Chrome from chrome://extensions/"
