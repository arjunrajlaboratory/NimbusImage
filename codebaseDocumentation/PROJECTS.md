# Projects Feature Documentation

## Overview

The Projects feature allows users to group datasets and collections for future export to Zenodo. Projects are abstract database objects (not tied to file structure) that reference datasets and collections by ID.

## Design Patterns

### Backend (Girder Plugin)

The backend follows the established patterns in the `upenncontrast_annotation` plugin:

1. **Model Pattern**: Uses `ProxiedModel` for change tracking and `customJsonSchemaCompile` for JSON validation
2. **API Pattern**: Uses `@autoDescribeRoute` decorators with `@access.user` for authentication and `@loadmodel`/`modelParam` for permission checks
3. **Database**: MongoDB with indices on `creatorId`, `lowerName`, and nested fields in `meta`

### Frontend (Vue 2 + TypeScript)

The frontend follows existing patterns:

1. **API Layer**: Separate API class (`ProjectsAPI.ts`) following `GirderAPI.ts` pattern
2. **State Management**: Vuex module with `vuex-module-decorators` (`projects.ts`)
3. **Components**: Vue class components with `vue-property-decorator`
4. **Dialogs**: V-dialog pattern with v-model for visibility control

## Key Files

### Backend

| File | Purpose |
|------|---------|
| `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/project.py` | Project model with schema validation, CRUD operations |
| `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/project.py` | REST API endpoints for projects |
| `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/__init__.py` | Plugin registration (model + API) |
| `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_project.py` | Backend tests |

### Frontend

| File | Purpose |
|------|---------|
| `src/store/model.ts` | `IProject` TypeScript interface |
| `src/store/ProjectsAPI.ts` | API client for project endpoints |
| `src/store/projects.ts` | Vuex store module for projects state |
| `src/components/ProjectList.vue` | List view of projects with search |
| `src/components/RecentProjects.vue` | Recent projects display for Home page |
| `src/components/AddToProjectDialog.vue` | Dialog for adding datasets to projects |
| `src/components/AddCollectionToProjectDialog.vue` | Dialog for adding collections to projects |
| `src/views/Home.vue` | Home page with Projects browse mode and Recent Projects tab |
| `src/views/dataset/DatasetInfo.vue` | Dataset info page with "Add to Project" button |
| `src/views/configuration/ConfigurationInfo.vue` | Collection info page with "Add to Project" button |

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
    };
    status: 'draft' | 'exporting' | 'exported';
  };
}
```

### Database Schema

Projects are stored in the `upenn_project` collection with:
- `name`: Project display name
- `description`: Optional description
- `creatorId`: ObjectId of the creating user
- `lowerName`: Lowercase name for case-insensitive search
- `meta.datasets[]`: Array of dataset references with `datasetId` and `addedDate`
- `meta.collections[]`: Array of collection references with `collectionId` and `addedDate`
- `meta.metadata`: Publication metadata (title, description, license, keywords)
- `meta.status`: Workflow status (draft → exporting → exported)

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

## UI Integration Points

### Home Page (`Home.vue`)

1. **Browse Mode Toggle**: Added "Projects" as third option alongside "Datasets" and "Collections"
2. **Recent Projects Tab**: Added tab between "Recent Datasets" and "Sample Datasets"

### Dataset Info Page (`DatasetInfo.vue`)

- "Add Dataset to Project..." button opens `AddToProjectDialog`

### Collection Info Page (`ConfigurationInfo.vue`)

- "Add Collection to Project..." button opens `AddCollectionToProjectDialog`

## Store Module (`projects.ts`)

### State
- `projects: IProject[]` - All loaded projects
- `currentProject: IProject | null` - Currently selected project

### Key Actions
- `fetchProjects()` - Load all projects for current user
- `createProject({ name, description })` - Create new project
- `addDatasetToProject({ projectId, datasetId })` - Add dataset reference
- `addCollectionToProject({ projectId, collectionId })` - Add collection reference
- `deleteProject(projectId)` - Delete a project

## Future Work

- [ ] Project detail view (`/project/:id`)
- [ ] Project editing UI (rename, update description)
- [ ] Remove dataset/collection from project UI
- [ ] Zenodo export integration
- [ ] Project sharing/permissions
