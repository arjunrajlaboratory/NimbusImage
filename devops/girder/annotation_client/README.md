Temporary repository to host a python library for interaction with the UPennContrast annotation plugin


## Transport

Every helper class builds its Girder client with
`annotation_client.transport.createGirderClient`, so all requests share one
code path:

- JSON responses are parsed with orjson from the response bytes, and JSON
  request bodies (`json=`) are encoded with orjson. Per 100K 25-vertex
  polygons that is about 0.5 s instead of 1.1 s to parse and 0.2 s instead of
  1.5 s to encode.
- NaN and Infinity still raise `ValueError` before anything is sent, as
  requests' `json=` (stdlib `allow_nan=False`) did.
- numpy scalars and C-contiguous arrays are serialized as their values.
  Before, only `np.float64` worked. Dataclasses and datetimes are still
  rejected with `TypeError`.
- Inputs orjson can't handle (non-str dict keys, ints past 64 bits, NaN
  tokens in a response, truncated bodies) go through the stdlib path, which
  accepts or raises exactly as before. Without orjson installed everything
  runs at stdlib speed.
- Requests share one `requests.Session`. GET, PUT and DELETE reuse
  keep-alive connections and retry 502/503 with backoff. 504 is not
  retried, because it arrives after the server timeout and a retry would
  rerun the slow request. A POST is never retried once sent, and it goes out
  on a fresh connection, as before. Any request that fails to connect at all
  (Girder restarting) is retried, since nothing reached the server. The
  session keeps no cookies, so the load balancer's sticky cookie doesn't pin
  a worker to one backend.

Tests: `pip install -e . numpy pytest && pytest tests`.
