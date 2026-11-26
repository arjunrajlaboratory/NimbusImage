# Projects Feature Documentation

## Overview

The Projects feature allows users to group datasets and collections for future export to Zenodo. Projects are abstract database objects (not tied to file structure) that reference datasets and collections by ID.

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend                                  │
├─────────────────────────────────────────────────────────────────┤
│  Views                          │  Components                    │
│  ├─ Home.vue (browse/tabs)      │  ├─ ProjectList.vue           │
│  ├─ ProjectRouter.vue           │  ├─ RecentProjects.vue        │
│  └─ project/                    │  ├─ AddToProjectDialog.vue    │
│      ├─ Project.vue             │  ├─ AddCollectionToProject... │
│      └─ ProjectInfo.vue         │  ├─ AddDatasetToProject...    │
│                                 │  └─ AddCollectionToProject... │
├─────────────────────────────────────────────────────────────────┤
│  Store                          │  API                           │
│  └─ projects.ts                 │  └─ ProjectsAPI.ts             │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Backend (Girder)                          │
├─────────────────────────────────────────────────────────────────┤
│  Model: project.py              │  API: project.py               │
│  └─ ProxiedModel pattern        │  └─ REST endpoints             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Patterns

### Backend (Girder Plugin)

The backend follows established patterns in the `upenncontrast_annotation` plugin:

1. **Model Pattern**: Uses `ProxiedModel` for change tracking and `customJsonSchemaCompile` for JSON validation
2. **API Pattern**: Uses `@autoDescribeRoute` decorators with `@access.user` for authentication and `@loadmodel`/`modelParam` for permission checks
3. **Database**: MongoDB with indices on `creatorId`, `lowerName`, and nested fields in `meta`

### Frontend (Vue 2 + TypeScript)

#### 1. Routing Pattern (`routeMapper`)

The project detail view uses the same routing pattern as datasets and configurations:

```typescript
// src/views/ProjectRouter.vue
export default routeMapper({
  projectId: {
    parse: String,
    get: () => projects.currentProjectId,
    set: (value: string) => projects.setSelectedProject(value),
  },
});
```

**How it works:**
- `routeMapper` creates a Vue component that syncs URL params ↔ Vuex store bidirectionally
- When URL changes → calls the `set()` function to update store
- When store changes → updates URL via `router.replace()`
- Prevents infinite loops via a `currentRouteChanges` counter

**Route hierarchy:**
```
/project                    → ProjectRouter.vue (maps projectId param)
  └─ /project/:projectId    → Project.vue (also uses routeMapper)
       └─ (default child)   → ProjectInfo.vue (the actual view)
```

#### 2. Store Module Pattern (`vuex-module-decorators`)

```typescript
// src/store/projects.ts
@Module({ dynamic: true, store, name: "projects" })
export class Projects extends VuexModule {
  // State
  projects: IProject[] = [];
  currentProjectId: string | null = null;

  // Getter (computed from state)
  get currentProject(): IProject | null {
    return this.projects.find((p) => p.id === this.currentProjectId) || null;
  }

  // Mutation (synchronous state change)
  @Mutation
  setCurrentProjectId(projectId: string | null) { ... }

  // Action (async, can call mutations)
  @Action
  async setSelectedProject(projectId: string | null): Promise<void> {
    this.setCurrentProjectId(projectId);
    if (projectId && !this.getProjectById(projectId)) {
      await this.fetchProject(projectId);
    }
  }
}
```

**Key pattern:** The `setSelectedProject` action sets the ID first, then fetches if needed. This allows the UI to show a loading state while data loads.

**Important:** Removed `isLoggedIn` check from `fetchProject` to allow page refresh to work (the API call will fail anyway if not authenticated).

#### 3. Info View Pattern (Single-Column Layout)

ProjectInfo.vue follows the same pattern as ConfigurationInfo.vue:

```vue
<v-container>
  <!-- Header with status chip and action buttons -->
  <v-container class="d-flex">
    <v-chip>{{ status }}</v-chip>
    <v-spacer />
    <v-btn>Workflow Action</v-btn>
    <v-dialog>Delete with confirmation</v-dialog>
  </v-container>

  <!-- Editable fields card -->
  <v-card>
    <v-text-field v-model="nameInput" @blur="tryUpdateName" />
  </v-card>

  <!-- List cards with add/remove actions -->
  <v-card>
    <v-card-title>Items ({{ count }})</v-card-title>
    <v-list>...</v-list>
    <v-card-actions>
      <div @click="addDialog = true">+ Add item</div>
    </v-card-actions>
  </v-card>

  <!-- Dialogs -->
  <v-dialog v-model="addDialog">
    <add-item-dialog @added="onAdded" @done="addDialog = false" />
  </v-dialog>
</v-container>
```

#### 4. Dialog Patterns

**Confirmation Dialog (inline):**
```vue
<v-dialog v-model="confirmDialog" max-width="33vw">
  <template #activator="{ on }">
    <v-btn color="red" v-on="on">Delete</v-btn>
  </template>
  <v-card>
    <v-card-title>Are you sure?</v-card-title>
    <v-card-actions>
      <v-btn @click="confirmDialog = false">Cancel</v-btn>
      <v-btn @click="doDelete" color="error">Delete</v-btn>
    </v-card-actions>
  </v-card>
</v-dialog>
```

**Content Dialog (external component):**
```vue
<v-dialog v-model="addDialog" width="60%">
  <add-item-dialog
    :parent="parent"
    @added="onAdded"
    @done="addDialog = false"
  />
</v-dialog>
```

#### 5. Form Change Detection Pattern

ProjectInfo.vue tracks metadata changes to enable/disable the Save button:

```typescript
// Store original values when form initializes
metadata: IProjectMetadataForm = { ... };
originalMetadata: IProjectMetadataForm = { ... };

// Initialize both with same values (deep copy for arrays)
initializeMetadata() {
  const values = { ...metaFromProject, keywords: [...keywords] };
  this.metadata = { ...values, keywords: [...values.keywords] };
  this.originalMetadata = { ...values, keywords: [...values.keywords] };
}

// Computed property detects changes
get hasMetadataChanges(): boolean {
  return (
    this.metadata.title !== this.originalMetadata.title ||
    // ... compare other fields ...
    JSON.stringify(this.metadata.keywords) !== JSON.stringify(this.originalMetadata.keywords)
  );
}

// Reset original after successful save
async saveMetadata() {
  await api.save(this.metadata);
  this.originalMetadata = { ...this.metadata, keywords: [...this.metadata.keywords] };
}
```

#### 6. Caching Pattern with Batch Loading

ProjectInfo.vue uses local caches for related data, with batch loading for efficiency:

```typescript
// Cache objects indexed by ID
datasetInfoCache: { [datasetId: string]: IGirderFolder } = {};
collectionInfoCache: { [collectionId: string]: IGirderItem } = {};
collectionDatasetViewsCache: { [collectionId: string]: IDatasetView[] } = {};

// Batch fetch on project load (avoids N individual API calls)
async fetchDatasetInfo() {
  const allDatasetIds = new Set<string>();
  // Collect direct datasets
  for (const d of this.project.meta.datasets) {
    allDatasetIds.add(d.datasetId);
  }
  // Collect datasets from collections
  for (const c of this.project.meta.collections) {
    const views = this.collectionDatasetViewsCache[c.collectionId] || [];
    for (const v of views) {
      allDatasetIds.add(v.datasetId);
    }
  }
  // Single batch request
  await this.girderResources.batchFetchResources({
    folderIds: Array.from(allDatasetIds),
  });
  // Update local cache from global cache
  for (const id of allDatasetIds) {
    const folder = this.girderResources.watchFolder(id);
    if (folder) Vue.set(this.datasetInfoCache, id, folder);
  }
}
```

#### 7. Unified Dataset List Pattern

ProjectInfo.vue combines direct datasets with collection datasets using deduplication:

```typescript
interface IUnifiedDatasetItem {
  datasetId: string;
  addedDate: string;
  info: IGirderFolder | undefined;
  source: "direct" | "collection";
  collectionIds: string[];  // Collections this dataset belongs to
}

get allDatasetItems(): IUnifiedDatasetItem[] {
  const datasetMap = new Map<string, IUnifiedDatasetItem>();

  // Add direct datasets first
  for (const d of this.project?.meta.datasets || []) {
    datasetMap.set(d.datasetId, {
      datasetId: d.datasetId,
      addedDate: d.addedDate,
      info: this.datasetInfoCache[d.datasetId],
      source: "direct",
      collectionIds: [],
    });
  }

  // Add/update with collection datasets (tracks which collections contain each)
  for (const c of this.project?.meta.collections || []) {
    const views = this.collectionDatasetViewsCache[c.collectionId] || [];
    for (const v of views) {
      const existing = datasetMap.get(v.datasetId);
      if (existing) {
        existing.collectionIds.push(c.collectionId);
      } else {
        datasetMap.set(v.datasetId, { ...newItem, collectionIds: [c.collectionId] });
      }
    }
  }

  return Array.from(datasetMap.values());
}
```

---

## Key Files

### Backend

| File | Purpose |
|------|---------|
| `devops/girder/plugins/.../server/models/project.py` | Project model with schema validation, CRUD operations |
| `devops/girder/plugins/.../server/api/project.py` | REST API endpoints for projects |
| `devops/girder/plugins/.../test/test_project.py` | Backend tests (11 tests) |

### Frontend - Store & API

| File | Purpose |
|------|---------|
| `src/store/model.ts` | `IProject` and `TProjectStatus` TypeScript types |
| `src/store/ProjectsAPI.ts` | API client wrapping REST endpoints |
| `src/store/projects.ts` | Vuex module with state, getters, mutations, actions |

### Frontend - Routing

| File | Purpose |
|------|---------|
| `src/views/index.ts` | Main routes, registers `/project` path |
| `src/views/ProjectRouter.vue` | routeMapper component for URL↔store sync |
| `src/views/project/index.ts` | Project route configuration |
| `src/views/project/Project.vue` | Parent route component (also uses routeMapper) |
| `src/views/project/ProjectInfo.vue` | Main project detail view |

### Frontend - Components

| File | Purpose |
|------|---------|
| `src/components/ProjectList.vue` | Browse projects list with search, create, edit, delete |
| `src/components/RecentProjects.vue` | Recent projects for Home page tab |
| `src/components/AddToProjectDialog.vue` | Add dataset/collection from their info pages |
| `src/components/AddCollectionToProjectDialog.vue` | Add collection from ConfigurationInfo |
| `src/components/AddDatasetToProjectDialog.vue` | File browser to add datasets (in ProjectInfo) |
| `src/components/AddCollectionToProjectFilterDialog.vue` | Filterable list to add collections (in ProjectInfo) |
| `src/components/ShareProject.vue` | Share project dialog with confirmation dialogs |

### Frontend - Integration Points

| File | Changes |
|------|---------|
| `src/views/Home.vue` | Added Projects browse mode, Recent Projects tab |
| `src/views/dataset/DatasetInfo.vue` | Added "Add Dataset to Project..." button |
| `src/views/configuration/ConfigurationInfo.vue` | Added "Add Collection to Project..." button |

---

## Data Model

### IProject Interface

```typescript
interface IProject {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  created: string;
  updated: string;
  public?: boolean;        // Exposed at READ level from backend
  _accessLevel?: number;   // Injected by Girder's @filtermodel (0=READ, 1=WRITE, 2=ADMIN)
  meta: {
    datasets: Array<{ datasetId: string; addedDate: string }>;
    collections: Array<{ collectionId: string; addedDate: string }>;
    metadata: {
      title: string;
      description: string;
      license: string;
      keywords: string[];
      authors?: string;
      doi?: string;
      publicationDate?: string;
      funding?: string;
    };
    status: 'draft' | 'exporting' | 'exported';
  };
}

type TProjectStatus = 'draft' | 'exporting' | 'exported';
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/project` | Create a new project |
| GET | `/project` | List projects (filterable by creatorId, status) |
| GET | `/project/:id` | Get project by ID (includes `public` and `_accessLevel`) |
| PUT | `/project/:id` | Update project name/description |
| DELETE | `/project/:id` | Delete project |
| POST | `/project/:id/dataset` | Add dataset to project |
| DELETE | `/project/:id/dataset/:datasetId` | Remove dataset from project |
| POST | `/project/:id/collection` | Add collection to project |
| DELETE | `/project/:id/collection/:collectionId` | Remove collection from project |
| PUT | `/project/:id/status` | Update project status |
| PUT | `/project/:id/metadata` | Update publication metadata |
| POST | `/project/:id/share` | Share project with user (propagates to the resources the caller can share) |
| POST | `/project/:id/set_public` | Make project and the resources the caller owns public/private |
| GET | `/project/:id/access` | Get access list for a project (requires ADMIN) |

---

## Store Module (`projects.ts`)

### State
- `projects: IProject[]` - All loaded projects
- `currentProjectId: string | null` - Currently selected project ID

### Getters
- `currentProject` - Returns the project matching currentProjectId
- `getProjectById(id)` - Find project by ID
- `recentProjects` - Last 5 projects sorted by updated date
- `projectsWithDataset(datasetId)` - Projects containing a specific dataset

### Key Actions
- `fetchProjects()` - Load all projects for current user
- `fetchProject(projectId)` - Load single project by ID
- `setSelectedProject(projectId)` - Set current project (used by routeMapper)
- `createProject({ name, description })` - Create new project
- `updateProject({ projectId, name, description })` - Update project fields
- `deleteProject(projectId)` - Delete a project
- `addDatasetToProject({ projectId, datasetId })` - Add dataset reference
- `removeDatasetFromProject({ projectId, datasetId })` - Remove dataset reference
- `addCollectionToProject({ projectId, collectionId })` - Add collection reference
- `removeCollectionFromProject({ projectId, collectionId })` - Remove collection reference
- `updateProjectMetadata({ projectId, metadata })` - Update publication metadata
- `updateProjectStatus({ projectId, status })` - Update workflow status

---

## UI Features

### Home Page
- **Browse Mode Toggle**: "Datasets and Files" | "Collections" | "Projects"
- **Recent Projects Tab**: Shows last 5 projects with status, counts, owner

### Project List (`/` with Projects mode)
- Search/filter projects by name or description
- Create new project dialog
- Edit project name/description via menu
- Delete project with confirmation
- Click to navigate to project detail

### Project Detail (`/project/:projectId`)
- **Header**: Status chip + total project size + workflow buttons (Start Export, Mark as Exported) + Delete
- **Editable Fields**: Name and description (blur to save)
- **Datasets List**:
  - Filter search bar for real-time name filtering
  - Unified view showing both direct datasets and datasets from collections
  - Individual dataset sizes displayed
  - Collection indicator chips (blue `#4baeff`) show which collection(s) contain each dataset
  - Chips are clickable and navigate to the collection
  - Remove button only shown for directly-added datasets
  - "No results" state when filter produces no matches
- **Collections List**:
  - Filter search bar for real-time name filtering
  - Expandable two-line list showing nested datasets with sizes
  - Collection size displayed (sum of dataset sizes)
  - Remove and View buttons per collection
  - "No results" state when filter produces no matches
- **Publication Metadata**: Title, description, license, keywords, authors, DOI, publication date, funding
  - Save button disabled until changes are detected (uses `originalMetadata` tracking pattern)

### Add to Project (from other pages)
- DatasetInfo: "Add Dataset to Project..." button → dialog to select/create project
- ConfigurationInfo: "Add Collection to Project..." button → dialog to select/create project

### Share Project Dialog (`ShareProject.vue`)

Opened from ProjectInfo. Allows the project owner to manage access:

- **Public toggle**: Checkbox to make public (read-only for everyone including anonymous)
- **Current access table**: Lists users with access level (Read/Write) and remove button
  - Owner shown as "Admin (Owner)" with a lock icon (cannot be removed)
  - Access level can be changed via dropdown
- **Add user form**: Username/email field + access level selector + Add button

**Confirmation dialogs**: Every sharing action shows a confirmation dialog before
executing, because actions propagate to the datasets, collections, configurations
and dataset views in the project that the caller can share (see "Permission
Propagation"). The dialog displays:
- Action-specific message explaining what will happen
- Resource counts: "This project has X datasets and Y collections; only the ones you own
  change..." (`impactSummary`; the client doesn't know ownership, so it states totals
  and the rule, not a count of what will change)

The confirmation is implemented with a single reusable `v-dialog` driven by a
`showConfirm()` helper that stores a pending action callback, executed on confirm.

| Action | Confirm Title | Button Color |
|--------|--------------|--------------|
| Add user | "Share Project" | primary |
| Change access level | "Change Access Level" | primary |
| Remove user | "Remove Access" | error |
| Make public | "Make Project Public" | primary |
| Make private | "Make Project Private" | warning |

---

## Permission Propagation

### Overview

When a project is shared with a user or made public, permissions must propagate to all
resources the project references: datasets (folders), collections (configurations),
and dataset views. This is handled by the model-layer propagation methods in
`project.py`.

### How It Works

Every propagation runs **as the acting user** (the `actor` argument) and changes a
contained resource only as far as that user could share it directly
(`server/helpers/aclLimits.py`, the same rules as `POST /dataset_view/share`):

- a dataset (folder) if the actor can edit it (WRITE), a dataset view if the actor can
  edit both the view and its dataset (also for views reached through a project
  collection whose dataset is not itself in the project), and a configuration if the
  actor can edit it (`limitToShareable`);
- an explicit share (`POST /project/:id/share`) is refused (403, nothing written) if it
  would grant more than the actor's level on any reached document, or change a user
  whose entry there is above it (`requireCanSetUserAccess`, as in
  `dataset_view/share`);
- copying the project's whole ACL onto a newly added resource caps each entry at the
  actor's level instead (`cappedCopyLevel`), so adding a dataset never fails over
  someone else's grant, and never lowers an existing entry, so adding your own dataset
  to a project where you are only WRITE keeps you its owner;
- the public flag only on resources the actor has ADMIN on.

`POST /project/:id/set_public` returns `skipped`, the number of contained resources the
caller can see but does not own, which it left unchanged (other users' private views are
not counted). Owner self-lockout (an owner removing or lowering their own ADMIN) is
PR #1165's concern. Zenodo upload needs ADMIN on every dataset and
collection the project lists; configurations reached only through views are exported
only if the uploader owns them; publish checks what the draft recorded
(`codebaseDocumentation/ZENODO_UPLOAD.md`). Invariants: "Regression checklist" below.

Without this, adding a dataset you could only edit to a project you own copied the
project's ACL -- where you are ADMIN -- onto the dataset, and `addCollection` reached
every dataset using the collection, even ones you could not read. Tests:
`test/test_share_escalation.py`.

**Sharing with a user (`POST /project/:id/share`):**
1. Caller must have ADMIN access on the project.
2. Looks up the target user by email or username (`findShareTarget`; share-link users are unknown).
3. Checks the project's own ACL with `requireCanSetUserAccess`: among other things, the change must leave the project at least one user at ADMIN (400 otherwise; `last_admin_guard`).
4. Calls `propagateUserAccess(project, targetUser, level, actor)`, which:
   - Bulk-loads all datasets, collections, and dataset views via `_gatherAllResources()`
   - Checks every reached resource first (`requireCanSetUserAccess`) and refuses the whole share (nothing written, the project's own ACL included) if it would grant more than the actor's level on one, or change a user whose entry there is above it (403), or leave a dataset with no user at ADMIN (400)
   - Then applies the same level to every reached resource with bulk `$pull`/`$push` updates (`_bulkSetUserAccess`); `None` only pulls
5. Only then calls `setUserAccess(project, targetUser, level)` on the project itself, so a refused share leaves the project unchanged.
6. Level `-1` revokes access: the endpoint maps it to `None` (`parseShareAccessType`), which removes the user's entry from the project's ACL and every reached resource's ACL. Passing `-1` straight through would store an inert `level: -1` entry instead.

**Making public/private (`POST /project/:id/set_public`):**
1. Caller must have ADMIN access on the project.
2. Calls `setPublic(project, public)` on the project itself.
3. Calls `propagatePublic(project, public, actor)` which:
   - Bulk-loads all resources via `_gatherAllResources()`
   - Sets `public` on each dataset, collection, and dataset view the actor owns

**Adding a resource to an already-shared project:**
- `addDataset` → calls `propagateAccessToDataset()` which applies the project's
  user ACL to the new dataset, its dataset views, and their configurations, as the
  caller may (above).
- `addCollection` → calls `propagateAccessToCollection()` similarly.

### Resource Discovery (`_gatherAllResources`)

The `_gatherAllResources()` method on the Project model uses bulk `$in` queries to
efficiently load all referenced resources:

1. Collects dataset IDs and collection IDs from `project.meta`
2. Bulk-loads datasets (Folders) and collections (CollectionModel)
3. Finds all DatasetViews linked to those datasets or collections via `$or` query
4. Discovers additional configurations from DatasetViews not already in the project's
   collection list (e.g., a dataset may have views with configurations not directly
   added to the project)

### Public vs Shared Access and Dataset Views

**Important distinction:** `setPublic()` grants READ-only access. `setUserAccess()`
grants whatever level is specified (READ, WRITE, or ADMIN).

This matters for dataset views because the `PUT /dataset_view/:id` endpoint (used to
save lastViewed, lastLocation, contrast overrides, etc.) requires **WRITE** access.

**How different access paths interact with dataset view updates:**

| Access Path | Access Level | Can view dataset? | Can update dataset view? |
|---|---|---|---|
| Anonymous (public dataset) | READ | Yes | No (skipped: `isLoggedIn` is false) |
| Logged-in via `set_public` only | READ | Yes | No (skipped: `canEditDatasetView` is false) |
| Logged-in via `share` at READ | READ | Yes | No (skipped: `canEditDatasetView` is false) |
| Logged-in via `share` at WRITE | WRITE | Yes | Yes |
| Owner / ADMIN | ADMIN | Yes | Yes |

The frontend guards all `updateDatasetView()` calls with `canEditDatasetView`, which
checks both `isLoggedIn` and `_accessLevel >= 1` (WRITE). This extends the existing
anonymous-user pattern to also cover logged-in users who only have READ access. Without
this guard, every logged-in read-only user would hit a 403 on the PUT call.

**Why the dataset-level `set_public` never hit this problem:** In practice, logged-in
users who accessed public datasets were typically also explicitly shared via the
`share` endpoint (which grants WRITE). The `set_public` endpoint was primarily used
for anonymous/unauthenticated access, where the `isLoggedIn` guard already skipped
the PUT. Project-level `set_public` is the first case where a logged-in user may have
only READ access without an explicit share.

### Key Files

| File | Role |
|------|------|
| `server/models/project.py` | `propagateUserAccess()`, `propagatePublic()`, `propagateAccessToDataset()`, `propagateAccessToCollection()`, `_gatherAllResources()` |
| `server/api/project.py` | `share()`, `setPublic()`, `getAccess()` endpoints |
| `src/store/index.ts` | `canEditDatasetView` getter, guards on `updateDatasetView()` calls |
| `src/store/model.ts` | `_accessLevel` field on `IDatasetView` |
| `src/store/GirderAPI.ts` | `asDatasetView()` preserves `_accessLevel` from API response |

### Backend Tests

Permission propagation is tested in `test_project.py` under `TestProjectPermissionPropagation`:

| Test | What it verifies |
|------|-----------------|
| `test_share_project_propagates_to_dataset` | Sharing a project grants access to its datasets, configs, and views |
| `test_share_project_propagates_to_collection` | Sharing a project grants access to its collections |
| `test_revoke_project_access_revokes_resources` | Revoking project access removes access from all resources |
| `test_add_dataset_syncs_existing_acl` | Adding a dataset to an already-shared project syncs the project's ACL |
| `test_propagate_public` | Making a project public/private propagates to all resources |

Note: Tests use `createPrivateFolder()` (not `createFolder()`) so datasets start with
restricted access and permission checks are meaningful.

### Detecting Shared/Public State for Confirmation Dialogs

When a user adds a dataset or collection to a project, the Add dialogs
(`AddDatasetToProjectDialog`, `AddCollectionToProjectFilterDialog`) show a
confirmation dialog if the project is shared or public, warning that permissions
will propagate to the new resource. The detection works differently depending on
the user's access level:

**`isProjectPublic`** — reads `project.public` directly from the project object.
The backend exposes `public` at `AccessType.READ` level in the project model's
`exposeFields`, so any user with READ+ access can see it. No additional API call
required.

**`isProjectShared`** — uses a two-tier approach:
1. **ADMIN users**: `fetchAccessInfo()` calls `GET /project/:id/access` and sets
   `projectAccessInfo`. If available, shared = `users.length > 1`.
2. **Non-ADMIN users**: The access endpoint returns 403 and `projectAccessInfo`
   stays `null`. Instead, the frontend checks `_accessLevel`: if the user has
   WRITE access (`_accessLevel >= 1`) but not ADMIN (`_accessLevel < 2`), they
   were explicitly added to the project, which means it is shared by definition.

This avoids the previous bug where WRITE-level users silently bypassed the
confirmation dialog because the ADMIN-only `getProjectAccess` call failed and
both flags defaulted to `false`.

**Key files for this detection:**
| File | Role |
|------|------|
| `server/models/project.py` | `exposeFields` includes `public` at READ level |
| `src/store/ProjectsAPI.ts` | `toProject()` maps `public` and `_accessLevel` |
| `src/store/model.ts` | `IProject` includes `public?` and `_accessLevel?` |
| `src/views/project/ProjectInfo.vue` | `isProjectPublic` / `isProjectShared` computed properties |

---

## Regression checklist

Sharing limits (`server/helpers/aclLimits.py`, `test/test_share_escalation.py`). Each
invariant names the test that holds it; re-check the group when you change any code
that writes an ACL or a public flag, or that exports a project.

**Direct sharing (`POST /dataset_view/share`)**
- A WRITE collaborator cannot grant ADMIN, to themselves or another account (403) —
  *"testWriteCollaboratorCannotGrantThemselvesAdmin"*,
  *"testWriteCollaboratorCannotGrantAdminToAnotherAccount"*.
- WRITE is enough to share, up to the caller's own level —
  *"testWriteCollaboratorCanShareUpToTheirLevel"*.
- A non-owner cannot remove the owner — *"testWriteCollaboratorCannotRemoveOwner"*.
- Owners can grant and remove ADMIN (nimbusimage `access="admin"`) —
  *"testOwnerCanGrantAdmin"*, *"testOwnerCanRemoveAccess"*.
- The level check runs on every touched document: granting ADMIN when the caller can
  only edit a configuration, or changing that configuration's owner, is refused and
  changes nothing — *"testGrantAboveCallersLevelOnConfigurationIsRefused"*,
  *"testConfigurationOwnerIsNotDowngraded"*.
- Views must belong to one dataset; an empty list is a 400, not a 500 —
  *"testViewsMustShareOneDataset"*, *"testEmptyViewListIsRejected"*.
- A dataset or project always keeps at least one user at ADMIN (`last_admin_guard`, PR
  #1165); its invariants are in `SHARING.md` "Regression checklist" ("Last ADMIN").

**Project propagation**
- Adding a dataset you can only edit to your own project does not make you its owner —
  *"testAddingDatasetToOwnProjectDoesNotGrantAdmin"*.
- `addCollection` does not reach datasets the caller cannot edit —
  *"testAddingCollectionDoesNotReachUnsharedDatasets"*.
- Sharing a project reaches what the caller could share directly (datasets, their
  views and collections the caller can edit) and is refused, project included, if it
  would exceed the caller's level on any of them —
  *"testSharingProjectReachesDatasetsCallerCanEdit"*,
  *"testSharingProjectReachesCollectionsCallerCanEdit"*,
  *"testSharingProjectAboveCallersLevelIsRefused"*.
- Copying the project ACL never lowers an existing entry, so the adder stays owner
  and a public project publishes all of their dataset —
  *"testAddingOwnDatasetToProjectKeepsOwnership"*,
  *"testAddingOwnDatasetToPublicProjectPublishesAllOfIt"*.
- Revoking a project member who owns a contained dataset (above the caller's level) is
  refused, so owners are never removed —
  *"testRevokingProjectMemberWhoOwnsAContainedDatasetIsRefused"*.
- A refused project share writes nothing on any dataset (all checks before any write) —
  *"testRefusedProjectShareWritesNothingAcrossDatasets"*.
- A view reached through a project collection travels only if the caller can edit its
  dataset — *"testCollectionViewOfOutsideDatasetNeedsThatDatasetEditable"*.
- Copying the project's ACL onto an added dataset caps every member's entry at the
  adder's level, not just the adder's — *"testAddedDatasetCapsOtherMembersAtTheAddersLevel"*.
- An owner sharing a project still grants ADMIN on its contents —
  *"testOwnerSharingProjectGrantsAdmin"*.
- `set_public` publishes only what the caller owns and reports the rest it can see, and
  the dialog shows that count — *"testPublishingProjectSkipsDatasetsCallerDoesNotOwn"*,
  *"testPublishingProjectReportsSkippedResources"*,
  *"testSkippedCountsOnlyResourcesTheCallerCanSee"*,
  *"words the notice for a single skipped resource"*,
  *"reports contained resources set_public left unchanged"*,
  *"shows no notice when set_public changed everything"*.
- The confirmation dialog does not claim every project resource is affected —
  *"does not claim every project resource is affected"*.

**Publishing (Zenodo)**
- Upload and publish need ADMIN on every dataset and collection the project lists —
  *"testUploadRefusesDatasetsCallerDoesNotOwn"*,
  *"testPublishRefusesDatasetsCallerDoesNotOwn"*,
  *"testUploadRefusesListedCollectionsCallerDoesNotOwn"*,
  *"testOwnerPassesTheOwnershipCheck"*.
- A configuration reached only through a dataset's views is exported (its property
  definitions) only if the uploader owns it, and otherwise left out, with its
  properties' values, rather than refusing the upload: anyone can create a view naming
  any dataset, and make it public — *"testExportSkipsConfigurationsCallerDoesNotOwn"*,
  *"testPublicStrangersViewDoesNotBlockTheExport"*,
  *"testStrangersViewsDoNotBlockTheExport"*,
  *"testExportOmitsValuesOfPropertiesItDoesNotDefine"*.
- Only views the uploader can edit count, so a stranger's view (even public, even
  pointing at the uploader's own configuration) cannot choose what the export contains
  — *"testStrangersViewCannotAddUploadersConfiguration"*.
- The upload job rechecks the project it reloads (resources can be added after the
  endpoint's check) — *"testUploadJobRechecksTheProjectItExports"* — and checks again
  immediately before reading any data, after its Zenodo calls —
  *"testUploadRechecksOwnershipBeforeReadingData"*.
- Anything deleted between the job's first check and that recheck is dropped, not
  exported from the stale snapshot nor recorded —
  *"testConfigurationDeletedBeforeTheRecheckIsNotExported"*.
- The export publishes the configurations the check returned, never re-queried views
  (a view can be repointed after the check) —
  *"testExportUsesTheConfigurationsItChecked"*.
- Publishing a draft checks the resources the upload recorded
  (`meta.zenodo.uploadedResources`), not the project's membership by then —
  *"testPublishChecksWhatTheDraftContains"*.
- A recorded resource that was deleted after the upload blocks publishing with 409 (its
  files are still in the draft and it can no longer be checked); upload still skips
  deleted references — *"testPublishRefusesDraftWithDeletedResources"*. The shared
  helper only reports what no longer exists; the endpoint decides that is an error —
  *"testResourcesAccessHelperReportsMissingInsteadOfRaising"*.
- The draft records only resources that existed and were exported (not references
  already deleted, nor configurations reached through a deleted dataset's views), or
  publish would refuse a valid draft — *"testUploadRecordsOnlyResourcesThatExist"*;
  the record is built from what the job loaded for upload, so a resource deleted
  between the check and that load is not recorded either (one deleted during the file
  uploads is recorded and then blocks publishing) —
  *"testDraftRecordsWhatTheJobUploaded"*.
- A draft without an upload record (from before these checks) cannot be published; it
  must be discarded and uploaded again (409) —
  *"testPublishRefusesDraftsWithoutAnUploadRecord"*.

**Process rules this feature proved**
- Test fixtures: Girder makes the first user in a fresh database a site admin, who holds
  ADMIN on everything; create custom users after `admin` and never use `admin` as the
  actor in a limits test.
- When a container (project) grants or exports, check every path that reaches a
  contained resource, including ones found indirectly (views, a collection's datasets,
  a view's configuration).
- Check what you act on, not a re-query of it: the Zenodo path took several review
  rounds because the endpoint, the job, the export and publish each derived the
  resource set separately. The check now returns the set (`ProjectContents`), the
  export uses it, and the draft records what was uploaded from it for publish.
- Refusing because of a resource someone else can attach is a denial of service:
  views reference datasets without any access check, so the export skips
  configurations the uploader does not own instead of refusing them, and filtering by
  "readable" is not enough (public views are readable by everyone).

---

## Future Work

- [x] Project detail view (`/project/:projectId`)
- [x] Project editing UI (rename, update description)
- [x] Remove dataset/collection from project UI
- [x] Publication metadata editing
- [x] Status workflow buttons
- [x] Dataset/collection size display (individual and total)
- [x] Dataset/collection filtering (search bars)
- [x] Unified dataset view (show collection datasets with indicator chips)
- [ ] Zenodo export integration
- [x] Project sharing/permissions (share, set_public, access list endpoints + propagation)
- [ ] Bulk operations (add multiple datasets/collections at once)
