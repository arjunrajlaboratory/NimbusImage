"""Shared limits for the plugin's aggregation pipelines.

Lives here rather than in a model so both the annotation and property-value
models can bound their pipelines without importing each other (annotation.py
already imports propertyValues.py).
"""

# Bound any single aggregation's DB runtime so one expensive query (e.g. over a
# 700K-annotation public dataset) can't run unbounded and pin a Mongo
# connection. 5 minutes: comfortably above the slowest legitimate query, but a
# hard ceiling against a runaway one.
AGGREGATION_MAX_TIME_MS = 300000
