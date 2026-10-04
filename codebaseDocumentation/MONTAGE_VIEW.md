# Montage View

A grid of image crops, one per object on the Object Browser's **current page**,
shown in place of the image view. It is frontend-only: crops come from the
existing `item/{id}/tiles/region` endpoint and outlines from the existing batch
hydrate endpoint.

Open it from the grid button in the dataset view's app bar (next to the 3D
toggle) or the command palette ("Open montage view"). It closes on the back
arrow, on a panel's "go to" button (which also navigates to that object), when
switching to a different dataset (by id, not on a reload of the same one), in
3D, and on leaving the dataset view.

Clicking a panel toggles that object's selection (shared with the list and the
image). Hovering a panel hovers the object everywhere, which also scrolls the
Object Browser to its row — the same linking an image hover gives.
Navigation is a button rather than double-click because a double-click also
delivers two clicks, which would toggle the selection off and on first.

## What it shows

- **Exactly the list's page.** Same filters, sort, page and page size as the
  Objects tab, in both client and server list modes. Changing the list's page
  pages the montage.
- **One square crop per object**, centered on its bounding box and padded by
  `padding` image pixels on every side. A point has an empty bounding box, so
  for points the padding alone sets the window (window side = 2 × padding).
- **Same scale** (default): every panel uses the largest window on the page, so
  object sizes compare directly. **Fit each**: each panel is zoomed to its own
  object.
- Crops use the current visible layers, colors and contrast (including personal
  contrast overrides), at **each object's own XY/Z/Time**, not the viewer's
  current frame.
- **Outlines** (toggle) in the object's display color; points draw as a ring.
- **Object number** (toggle): the list's Index column value.
- **Property labels**: any computed property, printed under each panel as
  `leafName: value`.
- **Export PNG** draws the same panels into one image, using the on-screen
  column count but at least √n columns, so a long page can't exceed the
  browser's canvas size limit.

Settings persist in localStorage (`montageSettings`). Label paths are filtered
to properties the current configuration has, because property ids are
per-configuration; choosing labels keeps the paths chosen under other
configurations. Labels refetch when the store's property-value map is
replaced (values computed or fetched).

## How it works

| Piece | Role |
|---|---|
| `src/store/montage.ts` | `isOpen`, persisted settings, and `listPageItems` (the published page) |
| `AnnotationList.vue` (`currentPageForMontage`) | Publishes the page it shows: server rows in server mode; the sorted mirror `dataTableItems` sliced by page in client mode |
| `src/components/Montage/MontageView.vue` | Resolves objects, hydrates outlines, fetches label values, builds crop URLs, toolbar, export |
| `src/components/Montage/MontagePanel.vue` | One `<canvas>`; asks for its crop when scrolled into view (observed within the grid), keeps the old crop until the new one has loaded, and frees its canvas and image when scrolled away |
| `src/utils/montage.ts` | Pure geometry (`montageWindows`, `clipToImage`, …) and `drawMontagePanel`, used by both the panels and the export |
| `src/utils/montageImageLoader.ts` | Concurrency-limited, reference-counted crop fetch + decode, LRU-cached under a byte budget; evicted bitmaps are `close()`d. |
| `Viewer.vue` | Mounts the montage **over** the image viewer (not instead of it), so closing returns to the same camera and tile state |

Why the list *publishes* its page instead of the montage re-deriving it: the
client-mode order lives in the list (Vuetify sorting mirrored by
`dataTableItems`), and server-mode paging is driven by the list's watchers.
Re-deriving either would be a second implementation that drifts. The publish
computed returns `[]` while the montage is closed, because the client path sorts
every filtered item.

Object resolution prefers the store's own full annotation (always fresh), then
one hydrated by the montage, then the stub (or server row). A hydrated copy
contributes only geometry; color and tags come from the current stub, so a
recolor from the Object Browser shows at once. Only unhydrated
**non-point** objects are hydrated, in one `upenn_annotation/hydrate` request
per page. Crop URLs wait for hydration so "same scale" windows aren't built from
stub radii and then rebuilt.

**Crops are built lazily.** A crop's URL carries a per-layer style, and in
percentile contrast mode that style needs a histogram for the object's own
frame. Building every panel's URL up front would fetch every frame's
histograms for a page spread over many frames, so a panel asks for its crop
only once visible, and builds share a pool of 4. Inputs (geometry, layers,
panel size) settle 250ms after the last change into a numbered generation,
which snapshots the dataset and layers each build will render with (so a
queued or export build can't mix render states); a
crop key is `generation:id`, keys are null while settling (panels keep their
current image), and a key from an older generation is rejected as stale. The
export builds the remaining offscreen crops itself (from the inputs it
captured, if settings move on mid-export), draws each as it arrives and lets
it go, shrinks the image to stay under Safari's ~16.7M-pixel canvas limit, and
reports how many crops failed. It is disabled while inputs are settling or
outlines are hydrating. Crop builds share a `p-limit` pool of 4.

**Off-screen panels hold nothing.** Beyond the observer's 200px margin a
panel has a 0×0 canvas and no decoded image (at 320px on a 2× display each is
~1.6MB, so a 200-object page would otherwise hold hundreds of MB). Scrolling
back usually gets the image from the loader's cache. A queued crop build
re-checks its generation when it starts, so rapid paging doesn't run builds
for pages already gone.

**A panel's image stays drawn at the rect it was fetched for**, not the
current window's rect. When padding, scale mode or the page's largest object
changes, the old crop stays correctly placed under the new window until the
new one arrives, instead of stretching or flashing black.

The Size slider applies when the drag ends. Crop URLs are built with the
shared `getBaseURLFromDownloadParameters` (whose `jpegQuality` key was
misspelled `jpeqQuality` before this branch, so Snapshots' JPEG quality was
being ignored).

Crops are requested at screen density (capped at 2×) and never above native
resolution; the canvas upsamples with smoothing off so pixels stay honest. The
part of a window outside the image is drawn as background, which keeps the
object centered and the scale uniform at image edges. Requests go through the
authenticated client (`getSnapshotImage`), so each unique crop also triggers a
CORS preflight, which is the same trade-off Snapshots makes.

## Layering

The overlay sits at z-index 1002: above ImageViewer's overlays (up to 1001),
below floating palettes (1006). It narrows to fit between open palettes using
App.vue's `--nimbus-left-palette-clear-x` / `--nimbus-right-edge-clear-x`, so
the Object Browser and Layers panels stay usable beside it.

The selection action panel (Delete/Tag/Color/Copy IDs/Deselect All,
z-index 1000) would sit under the montage, so while it is open App.vue sets
`montage-open` on `<v-app>` and the panel lifts to 1003 and moves to the
bottom (the montage toolbar runs along the top). Selecting panels in the
montage is a main use, so its actions must stay reachable.

## Not done (yet)

- Neighbouring objects are not drawn in a panel, only the panel's own object.
- A server-side montage endpoint (one sprite per page instead of one request
  per crop) was deliberately deferred until it is shown to be needed.

## Regression checklist

Run `pnpm test src/utils/montage.test.ts src/utils/montageImageLoader.test.ts src/components/Montage src/components/AnnotationBrowser/AnnotationList.test.ts`.

### Mirroring the list

- [ ] **The montage is exactly the list's page, in display order.** — *"is the client list's current page in display order"*, *"is the server page's rows in server mode"*
- [ ] **Sorting reorders the montage.** — *"follows the list's sort"*
- [ ] **A page past the end is clamped, as Vuetify does.** — *"clamps a page past the end like the table does"*
- [ ] **The page reaches the store when it changes.** — *"publishes the page to the montage store when it changes"*
- [ ] **Panels keep the published order.** — *"shows the list page's objects in list order"*

### Geometry and drawing

- [ ] **Points get a window from padding alone.** — *"sizes a point object's window by the padding alone"*
- [ ] **Same scale means one window size for every panel.** — *"gives every panel the largest window in uniform mode"*, *"gives every panel the same window size in uniform mode"*
- [ ] **Edge objects stay centered; the crop is offset, not stretched.** — *"draws a clipped crop offset by the part of the window off-image"*
- [ ] **Each crop is for the object's own frame.** — *"builds a crop only when a panel asks, for the object's own frame"*
- [ ] **Outlines map into panel space; polygons close, lines don't.** — *"maps outline coordinates into panel space and closes polygons"*, *"leaves lines open"*
- [ ] **Off-image objects report instead of requesting.** — *"reports an object outside the image instead of requesting it"*

### Cost

- [ ] **No sorting while the montage is closed.** — *"computes nothing while the montage is closed"*
- [ ] **Only non-point stubs are hydrated, in one request per page.** — *"hydrates only unhydrated non-point objects, in one request"*
- [ ] **A crop nobody holds is dropped before it starts** (fast paging must not queue stale pages). — *"drops a queued request nobody holds before it starts"*
- [ ] **Concurrency is capped and identical crops are fetched once.** — *"never runs more than the concurrency limit at once"*, *"fetches a URL once and shares the result"*
- [ ] **Failed crops are not cached.** — *"does not cache failures, so a later load retries"*
- [ ] **Unmount cancels pending crop work.** — *"cancels pending crop work on unmount"*

- [ ] **Crops are built only when a panel asks** (no up-front histogram fetches for offscreen panels). — *"builds a crop only when a panel asks, for the object's own frame"*
- [ ] **One build per crop per generation.** — *"builds each crop once per settled generation"*
- [ ] **The image cache is bounded by bytes and closes what it evicts, never a held image.** — *"evicts and closes the oldest unheld images past the byte budget"*, *"never closes an image someone still holds"*
- [ ] **Off-screen panels free their canvas and image.** — *"frees its image and canvas when scrolled away, and reloads on return"*
- [ ] **A panel releases a crop still loading when it moves on**, so the loader can drop it before it starts. — *"releases a crop still loading when it moves on to another"*
- [ ] **A generation renders with the layers it settled with.** — *"renders a generation with the layers it settled with"*
- [ ] **An image released while decoding is closed, not orphaned.** — *"closes an image whose request was released while it decoded"*
- [ ] **A queued build whose inputs changed doesn't run.** — *"drops a queued crop build whose inputs changed before it started"*

### Display while inputs change

- [ ] **A superseded crop key is rejected; keys are null while settling.** — *"rejects a crop key an input change has superseded"*
- [ ] **The old crop stays up, at its own rect, until the replacement loads.** — *"keeps the old crop until its replacement has loaded"*, *"shows its crop at the rect that crop was fetched for"*
- [ ] **A long export page stays within canvas limits** (≥ √n columns). — *"uses at least √n columns so a long page stays within canvas limits"*
- [ ] **Export waits for crops that match the current inputs.** — *"disables export until the crops match the current inputs"*
- [ ] **Export doesn't come out blank if settings change mid-export.** — *"exports from captured inputs when settings move on mid-export"*
- [ ] **Missing planes are typed, not matched by message.** — *"treats a missing plane as expected, other build failures as errors"*, *"types layer-selection failures so callers can tell them apart"*
- [ ] **Expected build errors show on the panel without being logged.** — *"shows an expected build error without logging it"*

### Lifecycle and interaction

- [ ] **Closes for another dataset (by id), in 3D, and on leaving the view; stays open on a same-dataset reload.** — *"closes the montage for a different dataset"*, *"keeps the montage open when the same dataset is reloaded"*, *"closes the montage when switching to 3D"*, *"closes the montage when leaving the view"*
- [ ] **Navigating doesn't toggle selection.** — *"navigates from its button without toggling selection"*
- [ ] **Closing under the cursor clears the hover.** — *"clears its hover when it closes under the cursor"*
- [ ] **Closing mid-export stops the work and doesn't download.** — *"renders nothing for a build that runs after the montage closed"*
- [ ] **Panels release their crops on unmount.** — *"releases its crop on unmount"*

- [ ] **Color and tags come from the current stub, geometry from the hydrated copy.** — *"takes color from the store's stub over a hydrated copy"*

### Labels

- [ ] **Labels from another configuration's properties are not shown, and choosing labels keeps theirs.** — *"only labels with properties this configuration has"*, *"keeps label choices made under other configurations"*
- [ ] **Labels refresh when property values are recomputed** (on `propertyValuesRevision`, not on lazy-mode viewport merges). — *"refetches labels when property values are recomputed"*
- [ ] **Clearing the padding field doesn't apply zero padding.** — *"ignores an emptied padding field"*

### Process notes

- Verify live on a client-mode dataset **and** one above the list threshold
  (20K): only the latter exercises stubs, server rows and hydration.
- Wrappers left mounted by other tests publish into the shared montage mock;
  assert on the instance's own `currentPageForMontage`, not the mock's last
  value.
