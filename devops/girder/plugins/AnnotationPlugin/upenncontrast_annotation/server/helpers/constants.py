"""Constants shared by more than one module of the plugin.

A constant read by a single module stays in that module. One read by
several modules lives here, so that changing it for one caller visibly
changes it for all of them instead of surprising a module that imported it
from somewhere unrelated.
"""

# Chunk size for `$in` queries over annotation ids. 50K ObjectIds are about
# 1 MB of BSON, far under MongoDB's 16 MiB command limit even when a query
# repeats the list (the connection cleanup's `$or` of two `$in`s). Read by
# the property-value lookups, the annotation/dataset membership check and
# the bulk-delete cleanup.
MAX_IDS_PER_QUERY = 50000

# Triggered with a list of the ObjectIds of annotations about to be removed:
# one id for a single delete, at most MAX_IDS_PER_QUERY per event for a bulk
# delete, and only ids of annotations that exist. Subscribers remove the
# annotations' dependents (connections, property values). An event name is
# a string nothing type-checks, so emitters and subscribers import it from
# here rather than spelling it out.
ANNOTATIONS_REMOVED_EVENT = "model.upenn_annotation.removeIds"

# The image tile pyramid that overlay tile routes render on (the annotation
# overview raster and saved scalar maps): accepted output tile edges, the
# largest image edge in pixels, and the deepest pyramid level.
OVERLAY_TILE_SIZES = (256, 512, 1024)
MAX_OVERLAY_IMAGE_EDGE = 131072
MAX_OVERLAY_PYRAMID_LEVEL = 30
