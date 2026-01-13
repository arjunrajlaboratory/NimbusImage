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

#### 6. Caching Pattern

ProjectInfo.vue uses local caches for related data:

```typescript
// Cache objects indexed by ID
datasetInfoCache: { [datasetId: string]: IGirderFolder } = {};
collectionInfoCache: { [collectionId: string]: IGirderItem } = {};

// Fetch and cache on project load
async fetchDatasetInfo() {
  for (const d of this.project.meta.datasets) {
    if (!this.datasetInfoCache[d.datasetId]) {
      const folder = await this.girderResources.getFolder(d.datasetId);
      Vue.set(this.datasetInfoCache, d.datasetId, folder);  // Reactive update
    }
  }
}

// Computed property combines list with cache
get datasetItems() {
  return this.project.meta.datasets.map((d) => ({
    datasetId: d.datasetId,
    info: this.datasetInfoCache[d.datasetId],
  }));
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
| GET | `/project/:id` | Get project by ID |
| PUT | `/project/:id` | Update project name/description |
| DELETE | `/project/:id` | Delete project |
| POST | `/project/:id/dataset` | Add dataset to project |
| DELETE | `/project/:id/dataset/:datasetId` | Remove dataset from project |
| POST | `/project/:id/collection` | Add collection to project |
| DELETE | `/project/:id/collection/:collectionId` | Remove collection from project |
| PUT | `/project/:id/status` | Update project status |
| PUT | `/project/:id/metadata` | Update publication metadata |

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
- **Header**: Status chip + workflow buttons (Start Export, Mark as Exported) + Delete
- **Editable Fields**: Name and description (blur to save)
- **Datasets List**: Two-line list with name/description, Remove and View buttons (styled to match ConfigurationInfo.vue)
- **Collections List**: Expandable two-line list (shows nested datasets), Remove and View buttons per collection
- **Publication Metadata**: Title, description, license, keywords, authors, DOI, publication date, funding
  - Save button disabled until changes are detected (uses `originalMetadata` tracking pattern)

### Add to Project (from other pages)
- DatasetInfo: "Add Dataset to Project..." button → dialog to select/create project
- ConfigurationInfo: "Add Collection to Project..." button → dialog to select/create project

---

## Future Work

- [x] Project detail view (`/project/:projectId`)
- [x] Project editing UI (rename, update description)
- [x] Remove dataset/collection from project UI
- [x] Publication metadata editing
- [x] Status workflow buttons
- [ ] Zenodo export integration
- [ ] Project sharing/permissions
- [ ] Bulk operations (add multiple datasets/collections at once)
