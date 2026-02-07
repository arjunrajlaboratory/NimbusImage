#!/usr/bin/env bash
#
# Convert SAM2 model checkpoints to ONNX format for browser inference.
#
# Usage:
#   ./scripts/convert_sam2_to_onnx.sh [model_type]
#
# Arguments:
#   model_type  One of: sam2_hiera_tiny (default), sam2_hiera_small,
#               sam2_hiera_base_plus, sam2_hiera_large
#
# Prerequisites:
#   - Python 3.11+ with pip
#   - wget or curl
#   - git
#
# The script creates a temporary directory, clones the required repos,
# downloads the checkpoint, exports to ONNX, and copies the results
# into public/onnx-models/sam/<model_type>/.

set -euo pipefail

MODEL_TYPE="${1:-sam2_hiera_tiny}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$PROJECT_DIR/sam2_onnx_conversion"

# Map model types to checkpoint URLs
declare -A CHECKPOINT_URLS=(
  ["sam2_hiera_tiny"]="https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_tiny.pt"
  ["sam2_hiera_small"]="https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_small.pt"
  ["sam2_hiera_base_plus"]="https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_base_plus.pt"
  ["sam2_hiera_large"]="https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt"
)

if [[ -z "${CHECKPOINT_URLS[$MODEL_TYPE]+_}" ]]; then
  echo "Error: Unknown model type '$MODEL_TYPE'"
  echo "Valid types: sam2_hiera_tiny, sam2_hiera_small, sam2_hiera_base_plus, sam2_hiera_large"
  exit 1
fi

CHECKPOINT_URL="${CHECKPOINT_URLS[$MODEL_TYPE]}"
CHECKPOINT_FILE="$MODEL_TYPE.pt"

echo "=== SAM2 to ONNX Conversion ==="
echo "Model type: $MODEL_TYPE"
echo "Working directory: $WORK_DIR"
echo ""

# Create working directory
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# Clone repos if not already present
if [ ! -d "samexporter" ]; then
  echo "--- Cloning samexporter ---"
  git clone https://github.com/vietanhdev/samexporter.git
fi

if [ ! -d "sam2" ]; then
  echo "--- Cloning sam2 ---"
  git clone https://github.com/facebookresearch/sam2.git
fi

# Install dependencies
echo "--- Installing dependencies ---"
pip install -e ./sam2
pip install torchvision onnx onnxruntime timm onnxsim

# Download checkpoint
mkdir -p original_models
if [ ! -f "original_models/$CHECKPOINT_FILE" ]; then
  echo "--- Downloading checkpoint: $MODEL_TYPE ---"
  wget -O "original_models/$CHECKPOINT_FILE" "$CHECKPOINT_URL"
else
  echo "--- Checkpoint already downloaded: $CHECKPOINT_FILE ---"
fi

# Export to ONNX
echo "--- Exporting encoder and decoder to ONNX ---"
cd samexporter
python -m samexporter.export_sam2 \
  --checkpoint "../original_models/$CHECKPOINT_FILE" \
  --output_encoder "../${MODEL_TYPE}.encoder.onnx" \
  --output_decoder "../${MODEL_TYPE}.decoder.onnx" \
  --model_type "$MODEL_TYPE"
cd ..

# Copy to project
OUTPUT_DIR="$PROJECT_DIR/public/onnx-models/sam/$MODEL_TYPE"
mkdir -p "$OUTPUT_DIR"
cp "${MODEL_TYPE}.encoder.onnx" "$OUTPUT_DIR/encoder.onnx"
cp "${MODEL_TYPE}.decoder.onnx" "$OUTPUT_DIR/decoder.onnx"

echo ""
echo "=== Done ==="
echo "ONNX models saved to: $OUTPUT_DIR"
echo "  encoder.onnx"
echo "  decoder.onnx"
echo ""
echo "You can now clean up the working directory:"
echo "  rm -rf $WORK_DIR"
