import logging
import statistics
from math import floor, log10

from girder.utility.model_importer import ModelImporter

logger = logging.getLogger(__name__)

# Cap on values returned/considered per numeric operation, to keep tool
# results and token usage bounded.
MAX_SAMPLE_ROWS = 500
MAX_PLOT_POINTS = 50000
MAX_BOX_POINTS = 20000
MAX_HISTOGRAM_BUCKETS = 1000
SIGNIFICANT_DIGITS = 6


def _clampBuckets(buckets):
    """Clamp a model-supplied bucket count to a range $bucketAuto accepts."""
    return min(max(int(buckets), 1), MAX_HISTOGRAM_BUCKETS)


def _roundSignificant(value, digits=SIGNIFICANT_DIGITS):
    """Round a float to a limited number of significant digits.

    Keeps numeric tool results compact to save tokens without losing
    meaningful precision.
    """
    if value is None:
        return None
    if value == 0:
        return 0.0
    try:
        exponent = digits - 1 - floor(log10(abs(value)))
        return round(value, exponent)
    except (ValueError, OverflowError):
        return value


def _toNumeric(value):
    """Resolve a leaf value to a float, or None if not numeric.

    Booleans are excluded since bool is a subclass of int in Python and
    would otherwise silently pass through as 0/1.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def resolvePath(valuesDict, pathParts):
    """Resolve a dotted property path against a nested values dict.

    :param valuesDict: The "values" sub-document for one annotation.
    :param pathParts: List of path segments (property id, then subIds).
    :returns: A float, or None if the path is missing or non-numeric.
    """
    current = valuesDict
    for part in pathParts:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return _toNumeric(current)


def _downsample(items, limit):
    """Deterministically downsample a sequence to at most `limit` items
    by taking every k-th item, preserving order."""
    n = len(items)
    if n <= limit:
        return items, False
    step = -(-n // limit)  # ceil division, so result size <= limit
    return items[::step], True


class AnalysisToolkit:
    """Per-request data access, tool implementations, and plot builders
    for the Claude analysis panel.

    All tools operate against a single dataset (Folder) ObjectId that is
    bound server-side at construction time; the model never supplies or
    chooses the datasetId.
    """

    def __init__(self, datasetObjectId):
        self.datasetId = datasetObjectId
        self._propertyValuesModel = ModelImporter.model(
            "annotation_property_values", "upenncontrast_annotation"
        )
        self._annotationModel = ModelImporter.model(
            "upenn_annotation", "upenncontrast_annotation"
        )
        self._valuesByAnnotationId = None
        self._annotationsById = None
        self.plots = []
        self._nextPlotIndex = 1

    # -- Cached data access -------------------------------------------

    def _getValuesByAnnotationId(self):
        if self._valuesByAnnotationId is None:
            cache = {}
            cursor = self._propertyValuesModel.find(
                {"datasetId": self.datasetId},
                fields=["annotationId", "values"],
            )
            for doc in cursor:
                cache[str(doc["annotationId"])] = doc.get("values", {})
            self._valuesByAnnotationId = cache
        return self._valuesByAnnotationId

    def annotation_count(self):
        return len(self._getAnnotationsById())

    def _getAnnotationsById(self):
        if self._annotationsById is None:
            cache = {}
            cursor = self._annotationModel.find(
                {"datasetId": self.datasetId},
                fields=["tags", "shape"],
            )
            for doc in cursor:
                cache[str(doc["_id"])] = doc
            self._annotationsById = cache
        return self._annotationsById

    def _firstTag(self, annotationId):
        annotation = self._getAnnotationsById().get(annotationId)
        if not annotation:
            return "untagged"
        tags = annotation.get("tags") or []
        return tags[0] if tags else "untagged"

    def _collectPathValues(self, path):
        """Return list of (annotationId, float) for a dotted path,
        skipping missing/non-numeric values."""
        pathParts = path.split(".")
        result = []
        for annotationId, values in self._getValuesByAnnotationId().items():
            numeric = resolvePath(values, pathParts)
            if numeric is not None:
                result.append((annotationId, numeric))
        return result

    def _nextPlotId(self):
        plotId = "plot-%d" % self._nextPlotIndex
        self._nextPlotIndex += 1
        return plotId

    # -- Tool schema ----------------------------------------------------

    def tool_definitions(self):
        return [
            {
                "name": "get_property_statistics",
                "description": (
                    "Compute summary statistics (count, mean, std, min, "
                    "max, median, p25, p75) for one or more numeric "
                    "property paths across all annotations in the "
                    "dataset. Use this first to understand the scale, "
                    "spread, and completeness of the data before "
                    "plotting."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "property_paths": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "Dotted property paths, e.g. "
                                "'propId' or 'propId.subId'."
                            ),
                        },
                    },
                    "required": ["property_paths"],
                },
            },
            {
                "name": "get_histogram",
                "description": (
                    "Get a binned histogram (min, max, count per bucket) "
                    "for one numeric property path. Use this to inspect "
                    "the distribution shape of a property before "
                    "deciding whether/how to plot it."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "property_path": {
                            "type": "string",
                            "description": "Dotted property path.",
                        },
                        "buckets": {
                            "type": "integer",
                            "description": "Number of buckets (default 50).",
                        },
                    },
                    "required": ["property_path"],
                },
            },
            {
                "name": "get_annotation_summary",
                "description": (
                    "Get the total annotation count and breakdowns by "
                    "tag and by shape (point/line/polygon/rectangle) for "
                    "the dataset. Use this to understand what "
                    "categorical groupings (e.g. for coloring plots by "
                    "tag) are available."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {},
                },
            },
            {
                "name": "get_sample_values",
                "description": (
                    "Get up to n sample rows (annotation id plus value "
                    "per requested property path) so you can eyeball raw "
                    "data before drawing conclusions or plotting."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "property_paths": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Dotted property paths.",
                        },
                        "n": {
                            "type": "integer",
                            "description": (
                                "Number of sample rows (default 20)."
                            ),
                        },
                    },
                    "required": ["property_paths"],
                },
            },
            {
                "name": "create_scatter_plot",
                "description": (
                    "Create an interactive scatter plot of one property "
                    "against another. Use this to visualize relationships "
                    "or correlations between two numeric properties. "
                    "Points with a missing value on either axis are "
                    "dropped."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "x_path": {
                            "type": "string",
                            "description": (
                                "Dotted property path for the x-axis."
                            ),
                        },
                        "y_path": {
                            "type": "string",
                            "description": (
                                "Dotted property path for the y-axis."
                            ),
                        },
                        "title": {
                            "type": "string",
                            "description": "Plot title.",
                        },
                        "x_label": {
                            "type": "string",
                            "description": "Optional x-axis label.",
                        },
                        "y_label": {
                            "type": "string",
                            "description": "Optional y-axis label.",
                        },
                        "color_by_tag": {
                            "type": "boolean",
                            "description": (
                                "If true, color points by each "
                                "annotation's first tag (one trace per "
                                "tag; untagged annotations grouped "
                                "together)."
                            ),
                        },
                    },
                    "required": ["x_path", "y_path", "title"],
                },
            },
            {
                "name": "create_histogram_plot",
                "description": (
                    "Create an interactive histogram (bar chart of "
                    "binned counts) for one numeric property path. Use "
                    "this to visualize the distribution of a single "
                    "property."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "property_path": {
                            "type": "string",
                            "description": "Dotted property path.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Plot title.",
                        },
                        "buckets": {
                            "type": "integer",
                            "description": "Number of buckets (default 50).",
                        },
                        "x_label": {
                            "type": "string",
                            "description": "Optional x-axis label.",
                        },
                    },
                    "required": ["property_path", "title"],
                },
            },
            {
                "name": "create_box_plot",
                "description": (
                    "Create an interactive box plot for one or more "
                    "numeric property paths, or for one property path "
                    "grouped by tag. Use this to compare distributions "
                    "across properties or across categories."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "property_paths": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Dotted property paths.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Plot title.",
                        },
                        "group_by_tag": {
                            "type": "boolean",
                            "description": (
                                "If true and exactly one property path is "
                                "given, create one box per tag instead of "
                                "one box per property path."
                            ),
                        },
                    },
                    "required": ["property_paths", "title"],
                },
            },
        ]

    # -- Tool dispatch ----------------------------------------------------

    def run_tool(self, name, toolInput):
        handler = getattr(self, "_tool_" + name, None)
        if handler is None:
            raise ValueError("Unknown tool: %s" % name)
        return handler(toolInput)

    # -- Tool implementations ---------------------------------------------

    def _tool_get_property_statistics(self, toolInput):
        propertyPaths = toolInput["property_paths"]
        result = {}
        summaries = []
        for path in propertyPaths:
            values = [v for _, v in self._collectPathValues(path)]
            if not values:
                result[path] = {"count": 0}
                continue
            stats = {
                "count": len(values),
                "mean": _roundSignificant(statistics.fmean(values)),
                "min": _roundSignificant(min(values)),
                "max": _roundSignificant(max(values)),
                "median": _roundSignificant(statistics.median(values)),
            }
            if len(values) > 1:
                stats["std"] = _roundSignificant(statistics.stdev(values))
            else:
                stats["std"] = 0.0
            sortedValues = sorted(values)
            if len(sortedValues) > 1:
                quartiles = statistics.quantiles(
                    sortedValues, n=4, method="inclusive"
                )
                p25, p75 = quartiles[0], quartiles[2]
            else:
                p25 = p75 = sortedValues[0]
            stats["p25"] = _roundSignificant(p25)
            stats["p75"] = _roundSignificant(p75)
            result[path] = stats
            summaries.append("%s (n=%d)" % (path, len(values)))
        summary = "computed stats for %d path(s): %s" % (
            len(propertyPaths), ", ".join(summaries) or "none with data"
        )
        return result, summary

    def _tool_get_histogram(self, toolInput):
        propertyPath = toolInput["property_path"]
        buckets = _clampBuckets(toolInput.get("buckets", 50))
        rawBuckets = list(self._propertyValuesModel.histogram(
            propertyPath, self.datasetId, buckets
        ))
        result = [
            {
                "min": _roundSignificant(bucket.get("min")),
                "max": _roundSignificant(bucket.get("max")),
                "count": bucket.get("count"),
            }
            for bucket in rawBuckets
        ]
        summary = "histogram for %s: %d buckets" % (
            propertyPath, len(result)
        )
        return result, summary

    def _tool_get_annotation_summary(self, toolInput):
        annotations = self._getAnnotationsById()
        tagCounts = {}
        shapeCounts = {}
        for annotation in annotations.values():
            shape = annotation.get("shape", "unknown")
            shapeCounts[shape] = shapeCounts.get(shape, 0) + 1
            tags = annotation.get("tags") or []
            if not tags:
                tagCounts["untagged"] = tagCounts.get("untagged", 0) + 1
            for tag in tags:
                tagCounts[tag] = tagCounts.get(tag, 0) + 1
        result = {
            "totalCount": len(annotations),
            "byTag": tagCounts,
            "byShape": shapeCounts,
        }
        summary = "%d annotations, %d distinct tags, %d shapes" % (
            len(annotations), len(tagCounts), len(shapeCounts)
        )
        return result, summary

    def _tool_get_sample_values(self, toolInput):
        propertyPaths = toolInput["property_paths"]
        n = min(int(toolInput.get("n", 20)), MAX_SAMPLE_ROWS)
        valuesByAnnotationId = self._getValuesByAnnotationId()
        rows = []
        for annotationId in list(valuesByAnnotationId.keys())[:n]:
            values = valuesByAnnotationId[annotationId]
            row = {"annotationId": annotationId}
            for path in propertyPaths:
                numeric = resolvePath(values, path.split("."))
                row[path] = _roundSignificant(numeric)
            rows.append(row)
        summary = "%d sample rows across %d path(s)" % (
            len(rows), len(propertyPaths)
        )
        return rows, summary

    def _tool_create_scatter_plot(self, toolInput):
        xPath = toolInput["x_path"]
        yPath = toolInput["y_path"]
        title = toolInput["title"]
        xLabel = toolInput.get("x_label") or xPath
        yLabel = toolInput.get("y_label") or yPath
        colorByTag = bool(toolInput.get("color_by_tag", False))

        xValues = dict(self._collectPathValues(xPath))
        yValues = dict(self._collectPathValues(yPath))
        annotationIds = [
            annotationId for annotationId in xValues
            if annotationId in yValues
        ]

        downsampled = False
        if len(annotationIds) > MAX_PLOT_POINTS:
            annotationIds, downsampled = _downsample(
                annotationIds, MAX_PLOT_POINTS
            )

        if colorByTag:
            groups = {}
            for annotationId in annotationIds:
                tag = self._firstTag(annotationId)
                groups.setdefault(tag, []).append(annotationId)
            traces = []
            for tag, ids in groups.items():
                traces.append({
                    "type": "scattergl",
                    "mode": "markers",
                    "name": tag,
                    "x": [xValues[i] for i in ids],
                    "y": [yValues[i] for i in ids],
                    "marker": {"size": 5, "opacity": 0.7},
                })
        else:
            traces = [{
                "type": "scattergl",
                "mode": "markers",
                "name": title,
                "x": [xValues[i] for i in annotationIds],
                "y": [yValues[i] for i in annotationIds],
                "marker": {"size": 5, "opacity": 0.7},
            }]

        plotTitle = title + (" (downsampled)" if downsampled else "")
        plot = {
            "id": self._nextPlotId(),
            "title": plotTitle,
            "data": traces,
            "layout": {
                "title": plotTitle,
                "xaxis": {"title": xLabel},
                "yaxis": {"title": yLabel},
                "hovermode": "closest",
            },
        }
        self.plots.append(plot)
        result = {
            "status": "created",
            "points": len(annotationIds),
            "plotId": plot["id"],
        }
        summary = "scatter plot '%s' with %d points" % (
            plotTitle, len(annotationIds)
        )
        return result, summary

    def _tool_create_histogram_plot(self, toolInput):
        propertyPath = toolInput["property_path"]
        title = toolInput["title"]
        buckets = _clampBuckets(toolInput.get("buckets", 50))
        xLabel = toolInput.get("x_label") or propertyPath

        rawBuckets = list(self._propertyValuesModel.histogram(
            propertyPath, self.datasetId, buckets
        ))
        xCenters = []
        widths = []
        counts = []
        for bucket in rawBuckets:
            bucketMin = bucket.get("min")
            bucketMax = bucket.get("max")
            if bucketMin is None or bucketMax is None:
                continue
            xCenters.append((bucketMin + bucketMax) / 2.0)
            widths.append(bucketMax - bucketMin)
            counts.append(bucket.get("count"))

        trace = {
            "type": "bar",
            "name": title,
            "x": xCenters,
            "y": counts,
            "width": widths,
        }
        plot = {
            "id": self._nextPlotId(),
            "title": title,
            "data": [trace],
            "layout": {
                "title": title,
                "xaxis": {"title": xLabel},
                "yaxis": {"title": "count"},
                "hovermode": "closest",
                "bargap": 0,
            },
        }
        self.plots.append(plot)
        result = {
            "status": "created",
            "points": len(counts),
            "plotId": plot["id"],
        }
        summary = "histogram plot '%s' with %d buckets" % (
            title, len(counts)
        )
        return result, summary

    def _tool_create_box_plot(self, toolInput):
        propertyPaths = toolInput["property_paths"]
        title = toolInput["title"]
        groupByTag = bool(toolInput.get("group_by_tag", False))

        traces = []
        if groupByTag and len(propertyPaths) == 1:
            path = propertyPaths[0]
            pathValues = dict(self._collectPathValues(path))
            groups = {}
            for annotationId, value in pathValues.items():
                tag = self._firstTag(annotationId)
                groups.setdefault(tag, []).append(value)
            for tag, values in groups.items():
                sampled, _ = _downsample(values, MAX_BOX_POINTS)
                traces.append({
                    "type": "box",
                    "name": tag,
                    "y": sampled,
                })
        else:
            for path in propertyPaths:
                values = [v for _, v in self._collectPathValues(path)]
                sampled, _ = _downsample(values, MAX_BOX_POINTS)
                traces.append({
                    "type": "box",
                    "name": path,
                    "y": sampled,
                })

        plot = {
            "id": self._nextPlotId(),
            "title": title,
            "data": traces,
            "layout": {
                "title": title,
                "hovermode": "closest",
            },
        }
        self.plots.append(plot)
        result = {
            "status": "created",
            "traces": len(traces),
            "plotId": plot["id"],
        }
        summary = "box plot '%s' with %d trace(s)" % (title, len(traces))
        return result, summary
