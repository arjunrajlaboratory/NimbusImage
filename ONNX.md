# Segment Anything 2 Tool

The segment anything tool uses [Segment Anything Model 2](https://github.com/facebookresearch/sam2) (SAM2).
This folder contains the ONNX files that represent the SAM2 model and are used by the browser to compute segmentations.

## Get model checkpoint

SAM2 checkpoints are [provided by Facebook](https://github.com/facebookresearch/sam2#download-checkpoints).
There are four model sizes: `sam2_hiera_tiny`, `sam2_hiera_small`, `sam2_hiera_base_plus`, and `sam2_hiera_large`.
It is advised to use `sam2_hiera_tiny` or `sam2_hiera_small` for browser inference, as larger models will be too slow.

Download checkpoints from:
- Tiny: https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_tiny.pt
- Small: https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_small.pt

## Convert to ONNX

The conversion uses [samexporter](https://github.com/vietanhdev/samexporter), which supports exporting both the encoder and decoder for SAM2.

A convenience script `scripts/convert_sam2_to_onnx.sh` is provided. See below for manual steps.

### Using the script

```sh
# From the NimbusImage project root:
./scripts/convert_sam2_to_onnx.sh
```

The script will:
1. Create a temporary working directory
2. Clone samexporter and sam2 repos
3. Install dependencies
4. Download the SAM2 Hiera Tiny checkpoint
5. Export encoder and decoder to ONNX
6. Copy the ONNX files to `public/onnx-models/sam/sam2_hiera_tiny/`

To convert additional models (e.g., small), edit the script or run the commands manually.

### Manual conversion

- Create a working directory:
```sh
mkdir sam2_conversion && cd sam2_conversion
```

- Clone the required repos:
```sh
git clone https://github.com/vietanhdev/samexporter.git
git clone https://github.com/facebookresearch/sam2.git
```

- Install dependencies (tested with Python 3.11):
```sh
pip install -e ./sam2
pip install torchvision onnx onnxruntime timm onnxsim
```

- Download the checkpoint:
```sh
mkdir -p original_models
wget -O original_models/sam2_hiera_tiny.pt \
  https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_tiny.pt
```

- Export encoder and decoder (from inside the samexporter directory):
```sh
cd samexporter
python -m samexporter.export_sam2 \
  --checkpoint ../original_models/sam2_hiera_tiny.pt \
  --output_encoder ../sam2_hiera_tiny.encoder.onnx \
  --output_decoder ../sam2_hiera_tiny.decoder.onnx \
  --model_type sam2_hiera_tiny
cd ..
```

- Copy to the project:
```sh
NIMBUS_DIR=/path/to/NimbusImage
MODEL_DIR="$NIMBUS_DIR/public/onnx-models/sam/sam2_hiera_tiny"
mkdir -p "$MODEL_DIR"
cp sam2_hiera_tiny.encoder.onnx "$MODEL_DIR/encoder.onnx"
cp sam2_hiera_tiny.decoder.onnx "$MODEL_DIR/decoder.onnx"
```

## Model details

### Encoder
- **Input:** `image` — float32 tensor of shape `(1, 3, 1024, 1024)`
- **Outputs:**
  - `high_res_feats_0` — high-resolution features (level 0)
  - `high_res_feats_1` — high-resolution features (level 1)
  - `image_embed` — image embedding

### Decoder
- **Inputs:**
  - `image_embed` — from encoder
  - `high_res_feats_0` — from encoder
  - `high_res_feats_1` — from encoder
  - `point_coords` — float32, shape `(1, N, 2)` — prompt point coordinates
  - `point_labels` — float32, shape `(1, N)` — prompt point labels (1=foreground, 0=background, 2=box top-left, 3=box bottom-right, -1=padding)
  - `mask_input` — float32, shape `(1, 1, 256, 256)` — previous mask (zeros if none)
  - `has_mask_input` — float32, shape `(1)` — 0 if no mask, 1 if mask provided
- **Outputs:**
  - `masks` — predicted segmentation mask
  - `iou_predictions` — confidence scores

### Key differences from SAM1
- Encoder outputs 3 tensors (was 1): adds `high_res_feats_0` and `high_res_feats_1`
- Encoder input name is `image` (was `input_image`)
- Decoder no longer takes `orig_im_size` — mask is output at a fixed resolution
- Decoder no longer outputs `low_res_masks`
- Normalization is the same (ImageNet mean/std)
