# Dataset Sharing System

This document describes the technical implementation of dataset sharing in NimbusImage.

## Overview

The sharing system allows dataset owners to:
- Grant read or write access to specific users
- Make datasets publicly accessible (read-only)
- View and manage who has access to their datasets
- Revoke access from users

## Permission Model

NimbusImage uses Girder's built-in access control system with three permission levels:

| Level | Value | Description |
|-------|-------|-------------|
| READ | 0 | View dataset, annotations, and configurations |
| WRITE | 1 | Edit annotations and configurations |
| ADMIN | 2 | Full control including sharing permissions |

**Key behaviors:**
- Users automatically receive ADMIN access when they create a dataset
- Only users with ADMIN access can modify sharing settings
- The dataset owner (ADMIN) cannot be removed from the access list

## Architecture

### Resources Affected by Sharing

When sharing a dataset, permissions are set on multiple Girder resources:

1. **Dataset Folder** - The main folder containing the dataset
2. **DatasetViews** - User-specific view configurations linking datasets to configurations
3. **Configurations (Collections)** - Tool definitions, layer settings, scales

All three resource types must have matching permissions for proper access.

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Dataset Folder │────▶│   DatasetView   │────▶│  Configuration  │
│    (Girder)     │     │   (Plugin DB)   │     │   (Plugin DB)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                    All receive same permissions
```

## Backend API

### Endpoints

#### `GET /dataset_view/access/:datasetId`

Returns the current access list for a dataset.

**Required permission:** ADMIN access to the dataset

**Response:**
```json
{
  "datasetId": "string",
  "public": true,
  "users": [
    {
      "id": "string",
      "login": "string",
      "name": "string",
      "email": "string",
      "level": 0
    }
  ],
  "groups": [],
  "configurations": [
    {
      "id": "string",
      "name": "string",
      "public": true
    }
  ]
}
```

**Implementation notes:**
- Uses `Folder().getFullAccessList()` for user list (doesn't include emails)
- Requires separate bulk query to fetch user emails
- Bulk loads configurations to avoid N+1 queries

#### `POST /dataset_view/share`

Grants, modifies, or revokes user access.

**Required permission:** WRITE access to the dataset and configurations

**Request body:**
```json
{
  "datasetViewIds": ["id1", "id2"],
  "userMailOrUsername": "user@example.com",
  "accessType": 0
}
```

**Access type values:**
- `0` - READ access
- `1` - WRITE access
- `null` - Remove access entirely

**Behavior:**
- Sets permissions on all specified DatasetViews
- Also sets permissions on the parent Dataset folder
- Also sets permissions on associated Configurations

#### `POST /dataset_view/set_public`

Makes a dataset and all associated resources public or private.

**Required permission:** ADMIN access to the dataset

**Query parameters:**
- `datasetId` - The dataset folder ID
- `public` - Boolean, true to make public

**Affected resources:**
- Dataset folder
- All DatasetViews for the dataset
- All Configurations used by those DatasetViews

## Frontend Implementation

### Component: `ShareDataset.vue`

Location: `src/components/ShareDataset.vue`

**Props:**
- `dataset` - The dataset object to share
- `value` - v-model for dialog visibility

**Key features:**
- Real-time updates (no "Save" button - each action immediately syncs)
- Individual loading states per user row
- Confirmation dialog before removing access
- ADMIN users protected from removal (lock icon)

### State Management

```typescript
// Access list data
isPublic: boolean
users: IDatasetAccessUser[]
configurations: IDatasetAccessConfiguration[]
selectedConfigIds: string[]

// Loading states
publicLoading: boolean
userLoading: string | null  // ID of user being modified
addUserLoading: boolean
```

### API Methods

Located in `src/store/GirderAPI.ts`:

```typescript
// Fetch current access list
async getDatasetAccess(datasetId: string): Promise<IDatasetAccessList>

// Share with a user (or revoke with accessType: null)
async shareDatasetView(
  datasetViews: IDatasetView[],
  userMailOrUsername: string,
  accessType: number | null
): Promise<true | string>

// Toggle public access
async setDatasetPublic(datasetId: string, isPublic: boolean): Promise<object>
```

### TypeScript Interfaces

Located in `src/store/model.ts`:

```typescript
interface IDatasetAccessUser {
  id: string;
  login: string;
  name: string;
  email: string;
  level: 0 | 1 | 2;
}

interface IDatasetAccessConfiguration {
  id: string;
  name: string;
  public: boolean;
}

interface IDatasetAccessList {
  datasetId: string;
  public: boolean;
  users: IDatasetAccessUser[];
  groups: unknown[];
  configurations: IDatasetAccessConfiguration[];
}
```

## UI Layout

```
+-----------------------------------------------+
| Share Dataset: [Dataset Name]                 |
+-----------------------------------------------+
| Select collections to share along with dataset|
| [x] Collection A                              |
| [x] Collection B                              |
+-----------------------------------------------+
| [x] Make Public (read-only access for all)    |
+-----------------------------------------------+
| Current Access:                               |
| | User          | Access    | Remove        | |
| | user@email    | [Read v]  | [X]           | |
| | jane.doe      | [Write v] | [X]           | |
| | owner         | Admin     | [lock icon]   | |
+-----------------------------------------------+
| Add User:                                     |
| [email/username    ] [Read v] [+ Add]        |
+-----------------------------------------------+
|                                      [Done]   |
+-----------------------------------------------+
```

## Error Handling

| Error | User Message |
|-------|--------------|
| Invalid email/username | "Unknown user. Please check the username or email." |
| Network error | "Failed to [action]" |
| No collections selected | "Please select at least one collection" |

## Future Considerations

1. **Permission visibility**: Currently only ADMIN users can see the access list. Consider allowing READ users to view (but not modify) who has access.

2. **Per-configuration public status**: The backend supports different public status per configuration, but the UI doesn't expose this since most datasets have a single configuration.

3. **Group support**: Girder supports group-based permissions, but the UI currently only handles individual users.

## File Locations

| File | Purpose |
|------|---------|
| `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/datasetView.py` | Backend API endpoints |
| `src/components/ShareDataset.vue` | Frontend dialog component |
| `src/store/GirderAPI.ts` | API client methods |
| `src/store/model.ts` | TypeScript interfaces |
