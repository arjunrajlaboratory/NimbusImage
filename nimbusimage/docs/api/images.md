# Images

Image retrieval, stacking, compositing, and line-scan intensity profiles.

## Line scan example

Measure an intensity profile along a line — the same computation as the
viewer's line scan tool. Works with an anonymous connection on public
datasets.

```python
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", anonymous=True)
ds = client.dataset("<public-dataset-id>")

# Straight segment (two points) or a freehand path (more points),
# in image pixel coordinates
scan = ds.images.line_scan([(120, 512), (520, 512)], channel=0, time=0)

scan.distances   # (N,) distance from start, in pixels
scan.values      # (N,) intensities; NaN where the line leaves the image
scan.points      # (N, 2) sampled (x, y) coordinates

# Distances in physical units
microns = scan.distances * ds.pixel_size.to("um").value
```

::: nimbusimage.images.ImageAccessor

::: nimbusimage.images.LineScanResult

::: nimbusimage.images.ImageWriter
