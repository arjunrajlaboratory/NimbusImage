# NimbusImage API — Gotchas and Known Issues

Things that will trip you up if you don't know about them.

## connect_to must have tags key

When using `connect_to` with `ds.annotations.compute()` or `ds.annotations.create_many()`, the dict **must** include a `tags` key, even if empty:

```python
# WRONG — causes KeyError in worker
connect_to={"channel": 0}

# RIGHT
connect_to={"tags": ["nucleus"], "channel": 0}
connect_to={"tags": []}  # no connections, but won't crash
```

## Worker parameter keys are exact strings

Worker interface parameters use human-readable names with spaces and capitalization. They must match exactly:

```python
# WRONG
worker_interface={"square_size": 15}

# RIGHT
worker_interface={"Square size": 15}
```

Always check with `client.get_worker_interface(image)` first.

## id vs _id

MongoDB stores `_id`, but some parts of the API expect `id`. The Python models use `id` as the Python attribute with `_id` as the alias for serialization. The `properties.compute()` method handles this remapping automatically, but be aware of it if using raw dicts.

## update_many has a known bug

`ds.annotations.update_many()` has a known bug (#780). Use individual `update()` calls for now.

## Connection update returns 500

`ds.connections.update()` has a backend bug (#1087) — the PUT endpoint has a parameter name mismatch. Workaround: delete and recreate.

## Coordinate conventions

NimbusImage coordinates have a 0.5 offset and x/y swap relative to numpy:
- Annotation coordinates: `{"x": col + 0.5, "y": row + 0.5}` in image space
- Numpy arrays: `array[row, col]`

The geometry helpers (`ann.polygon()`, `ann.get_mask()`, `from_polygon()`, `from_mask()`) handle this automatically. Don't manually convert coordinates unless you're working with raw coordinate dicts.

## ds.shape is (height, width)

Following numpy convention: `ds.shape` returns `(rows, cols)` = `(height, width)`, not `(width, height)`.

## list_datasets uses dataset_view endpoint

`client.list_datasets()` discovers datasets through dataset views, not a direct folder search. A dataset without any views won't appear in the list. Use `client.dataset(id)` directly if you have the folder ID.

## Composite needs layer settings

`ds.images.get_composite()` reads layer configuration from `ds.collections.layers`. If no collection/layers are configured for the dataset, it returns a blank image. You may need to set up layers in the UI first.

## Job status 3 is SUCCESS

Girder job status codes: 0=inactive, 1=queued, 2=running, **3=success**, 4=error, 5=cancelled. Status 3 means the job completed successfully — don't confuse it with "still running."

## Property registration is required

After creating a property definition with `ds.properties.create()`, you must call `ds.properties.register(prop.id)` before values will be visible in the NimbusImage UI. The registration adds the property ID to the dataset's collection configuration.

## Collections = Configurations

In the codebase and API, "collections" and "configurations" refer to the same concept. The backend endpoint is `/upenn_collection`. The Python API uses `ds.collections`.
