"""Virtual property paths answered by another plugin.

A property path is `[propertyId, subKey, ...]` read from the property-values
collection. A path whose FIRST segment is a registered prefix is virtual: the
registered provider answers for it instead of Mongo, so the analysis axes,
property filters, color-by, the list page, the batch value fetch and the
selection summary all take, say, `["spatial", "CD3E"]` — the CD3E column of a
dataset's expression table — without this plugin knowing what a gene is.

Providers are plain objects with three methods (see SPATIAL_PLUGIN.md for the
one implementation):

    values(datasetId, path) -> {annotationId(str): number}
        Dense over every row the provider knows for the dataset; an
        annotation absent from the result has NO value at the path.
    valuesForIds(datasetId, path, annotationIds) -> [number | None]
        One entry per requested id, None where the annotation has no row.
    matchingIds(datasetId, path, propertyFilter) -> [annotationId(str)]
        The annotations whose value satisfies a range ({min, max}) or values
        ({values}) property filter — the same object the list filters carry.

Providers raise ValueError for a path they cannot resolve (unknown sub key);
callers map that to a 400 exactly as they do for over-budget gates.
"""

_providers = {}


def registerValueProvider(prefix, provider):
    _providers[prefix] = provider


def providerFor(path):
    """The provider owning `path`, or None for an ordinary property path."""
    if isinstance(path, (list, tuple)) and path:
        return _providers.get(path[0])
    return None


def isVirtualPath(path):
    return providerFor(path) is not None


def splitPaths(paths):
    """(stored paths, virtual paths) preserving order."""
    stored, virtual = [], []
    for path in paths:
        (virtual if isVirtualPath(path) else stored).append(path)
    return stored, virtual


def nestValue(values, path, value):
    """values[path[0]][path[1]]... = value, creating the intermediate dicts."""
    node = values
    for key in path[:-1]:
        node = node.setdefault(key, {})
    node[path[-1]] = value
