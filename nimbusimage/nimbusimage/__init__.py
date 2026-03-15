"""NimbusImage Python API."""

from nimbusimage.coordinates import attach_geometry_methods

# Attach geometry methods (polygon, point, get_mask, etc.) to Annotation
attach_geometry_methods()
