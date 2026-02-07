# SAM Migration: SAM1 + SAM2 Support

## Overview

The SAM (Segment Anything Model) tool now supports both SAM1 and SAM2 architectures. SAM1 uses a Vision Transformer (ViT-B) backbone; SAM2 uses Meta's newer Hierarchical Vision Transformer (Hiera) backbone. The pipeline code discriminates between the two at runtime using `isSam2Model()`, handling their different encoder/decoder interfaces transparently.

### Migration History

1. **Original**: SAM1 ViT-B only
2. **First migration**: Replaced SAM1 with SAM2 Tiny and Small. SAM2 Tiny/Small did not meaningfully outperform SAM1 in practice.
3. **Current**: Restored SAM1 ViT-B as a reliable baseline. Replaced SAM2 Tiny/Small with Base+ and Large, which are expected to offer genuine quality improvements over SAM1.

## Architecture Differences: SAM1 vs SAM2

### Encoder

| | SAM1 (ViT-B) | SAM2 (Hiera) |
|---|---|---|
| File format | `.onnx` | `.ort` (pre-optimized, see below) |
| Input tensor name | `input_image` | `image` |
| Output tensors | 1: `image_embeddings` | 3: `image_embed`, `high_res_feats_0`, `high_res_feats_1` |
| Execution provider | `["webgpu"]` | `["webgpu"]` |

### Decoder

| | SAM1 | SAM2 |
|---|---|---|
| Extra input | `orig_im_size` (tells decoder the original image dimensions) | None (not needed) |
| Extra output | `low_res_masks` | None |
| Mask output | Resized to original image dimensions by the model | Fixed resolution; requires manual rescaling in code |

### Key Code Difference: Coordinate Rescaling

SAM1's decoder accepts `orig_im_size` and outputs masks already scaled to the source image dimensions. SAM2's decoder outputs masks at a fixed resolution, so `rescaleMaskToDisplayCoords()` rescales polygon coordinates from mask space back to display space. The pipeline conditionally wires this rescale node for SAM2 only.

## Model Variants

Three model variants are available, configured in `public/config/templates.json`:

| Model | Architecture | Encoder Size | Decoder Size | Notes |
|---|---|---|---|---|
| **vit_b** | SAM1 ViT-B | 343 MB (.onnx) | 16 MB | Proven baseline, fast |
| **sam2_hiera_base_plus** | SAM2 Hiera Base+ | 292 MB (.ort) | 20 MB | Better quality expected |
| **sam2_hiera_large** | SAM2 Hiera Large | 849 MB (.ort) | 20 MB | Best quality expected |

## Model File Layout

```
public/onnx-models/sam/
  vit_b/                    # SAM1
    encoder.onnx            # Standard ONNX format (loaded with WebGPU)
    decoder.onnx
  sam2_hiera_base_plus/     # SAM2 Base+
    encoder.ort             # ORT format (pre-optimized, required for WebGPU)
    decoder.onnx
  sam2_hiera_large/         # SAM2 Large
    encoder.ort
    decoder.onnx
```

These files are not committed to git (they're large binaries, gitignored via `public/onnx-models`). They are hosted on Hugging Face:

- [rajlab/sam_vit_b](https://huggingface.co/rajlab/sam_vit_b)
- [rajlab/sam2_hiera_base_plus](https://huggingface.co/rajlab/sam2_hiera_base_plus)
- [rajlab/sam2_hiera_large](https://huggingface.co/rajlab/sam2_hiera_large)
- Collection: [rajlab/sam-onnx-models](https://huggingface.co/collections/rajlab/sam-onnx-models-6629298d692901608b58c240)

To download and place them:
```bash
# Install huggingface_hub if needed
pip install huggingface_hub

# Download each model
huggingface-cli download rajlab/sam_vit_b --local-dir public/onnx-models/sam/vit_b
huggingface-cli download rajlab/sam2_hiera_base_plus --local-dir public/onnx-models/sam/sam2_hiera_base_plus
huggingface-cli download rajlab/sam2_hiera_large --local-dir public/onnx-models/sam/sam2_hiera_large
```

## ONNX/ORT Format Details

### Why .ort for SAM2 Encoders (but .onnx for SAM1)

SAM2 encoder models **must** be in ORT format (`.ort`), not raw ONNX (`.onnx`):

1. **Raw `.onnx` SAM2 encoders fail to load** in onnxruntime-web. The WebGPU and WASM backends both fail with opaque numeric error codes (e.g., `80068992`, `94260920`) during `InferenceSession.create()`. These are raw WASM memory pointers — ORT-web doesn't extract the actual error messages.

2. **The `.ort` format is ORT's pre-optimized format.** ORT normally runs graph optimization at session creation time. For SAM2's Hiera encoder, this runtime optimization fails silently in the browser. The `.ort` format has optimizations pre-baked.

3. **SAM1's ViT-B encoder works fine as `.onnx`** — it's a simpler architecture that ORT-web can optimize at runtime without issues. Decoders for both SAM1 and SAM2 also work fine as `.onnx`.

### ORT Conversion: Optimization Level Matters

When converting `.onnx` to `.ort`, use **`ORT_ENABLE_BASIC`** (not `ORT_ENABLE_ALL`):

- **`ORT_ENABLE_BASIC`** (correct): Standard graph optimizations without provider-specific transforms. Works with any backend.
- **`ORT_ENABLE_ALL`** (wrong): Inserts CPU-specific ops (e.g., `com.microsoft.nchwc:Conv`) that don't exist in the WebGPU backend.

## onnxruntime-web Version

Upgraded from `1.17.0-dev.20240111` to `1.19.0-dev.20240801-4b8f6dcbb6`.

The old version (from Jan 2024) predated SAM2 (Jul 2024) and had issues loading SAM2 models. The new version matches what the [webgpu-sam2](https://github.com/lucasgelfond/webgpu-sam2) reference project uses.

Note: The WASM filenames changed between versions. After upgrading, the dev server must be restarted so Vite re-copies the new WASM files from `node_modules/onnxruntime-web/dist/*.wasm` to the `onnx-wasm/` serving directory.

## Generating SAM2 Model Files (Colab Notebook)

The conversion notebook is at `scripts/convert_sam2_to_onnx.ipynb`. It exports SAM2 Base+ and Large:

1. **Clone repos**: samexporter + sam2 from GitHub
2. **Install deps**: PyTorch 2.5.1 (pinned — see below), sam2, onnx, onnxruntime, onnxsim
3. **Download checkpoints**: From Meta's CDN (official SAM2 weights)
4. **Export to ONNX**: Using samexporter's `export_sam2` module
5. **Convert encoders to ORT**: Using `onnxruntime.SessionOptions` with `ORT_ENABLE_BASIC`
6. **Download results**: 4 files (2 encoder `.ort` + 2 decoder `.onnx`)

### Why PyTorch 2.5.1 is Pinned

PyTorch 2.6+ defaults to a dynamo-based ONNX exporter whose `onnxscript` optimizer tries to constant-fold `Resize` operations pixel-by-pixel in pure Python, hanging forever on SAM2's large tensors. PyTorch 2.5.x uses the legacy TorchScript-based exporter which completes in minutes.

## Code Changes Summary

### `src/pipelines/samPipeline.ts`
- `samModelsConfig` defines three models: `vit_b`, `sam2_hiera_base_plus`, `sam2_hiera_large`
- `isSam2Model()` discriminates SAM1 vs SAM2 by checking `model.startsWith("sam2_")`
- `ISamEncoderContext` carries `model` field for downstream type discrimination
- `createEncoderSession()`: SAM1 loads `encoder.onnx`, SAM2 loads `encoder.ort`
- `processCanvas()`: SAM1 uses input tensor key `input_image`, SAM2 uses `image`
- `processPrompt()`: SAM1 includes `orig_im_size` tensor, SAM2 does not
- `createSamPipelineDecoderNodes()`: SAM2 wires `rescaleMaskToDisplayCoords` node, SAM1 skips it
- Encoder/decoder output types use generic `Record<string, TensorF32>` to accommodate both architectures

### `src/pipelines/computePipeline.ts`
- Improved error logging to show function name and proper error details

### `public/config/templates.json`
- SAM tool (`shortName: "SAM"`) offers three models: SAM1 ViT-B, SAM2 Hiera Base+, SAM2 Hiera Large

### `package.json`
- `onnxruntime-web`: `1.17.0-dev.20240111` -> `1.19.0-dev.20240801-4b8f6dcbb6`

### `scripts/convert_sam2_to_onnx.ipynb`
- Exports SAM2 Base+ and Large (was Tiny and Small)

## Reference Projects

- [webgpu-sam2](https://github.com/lucasgelfond/webgpu-sam2) — SAM2 running in the browser with WebGPU. Used as reference for ORT version, model format, and session configuration.
- [samexporter](https://github.com/vietanhdev/samexporter) — Tool for exporting SAM/SAM2 models to ONNX format.

## Potential Next Steps

- Evaluate SAM2 Base+ and Large quality versus SAM1 ViT-B in practice
- Look into quantized models for faster inference
