# User-Specific Channel Color Preferences

This feature allows users to customize the default colors assigned to fluorescence channels. When a user creates new layers, the system will use their personalized color preferences instead of the global defaults.

## Implementation Overview

### Backend Components

1. **API Endpoint**: `user_colors.py`
   - `GET /api/v1/user_colors` - Retrieve user's color preferences
   - `PUT /api/v1/user_colors` - Save user's color preferences

2. **Data Storage**: User color preferences are stored in the user's metadata field (`meta.channelColors`)

### Frontend Components

1. **Type Definitions**: Extended `IGirderUser` interface to include `meta.channelColors`
2. **API Methods**: `getUserColors()` and `setUserColors()` in `GirderAPI`
3. **Store Integration**: 
   - `userChannelColors` getter for accessing current user's colors
   - `loadUserColors()` and `saveUserColors()` actions
4. **Color Resolution**: `getChannelColors()` function merges user preferences with defaults
5. **UI Component**: `UserColorSettings.vue` for managing color preferences

## Usage

### For Users

1. Click on the user menu (account icon) in the top right
2. In the profile settings, scroll to "Channel Color Preferences"
3. Customize colors for your preferred channels (DAPI, GFP, etc.)
4. Click "Save Preferences"

### For Developers

```typescript
// Get merged colors (user preferences + defaults)
const colors = getChannelColors(store.userChannelColors);

// Create a new layer with user color preferences
const layer = newLayer(dataset, existingLayers, store.userChannelColors);

// Save user color preferences
await store.saveUserColors({
  'DAPI': '#0080FF',
  'GFP': '#00FF40',
  'CY3': '#FFDD00'
});
```

## Benefits

1. **Personalization**: Each user can set their preferred color scheme
2. **Consistency**: Colors persist across sessions and datasets
3. **Backward Compatibility**: Existing functionality unchanged; uses defaults when no user preferences exist
4. **Non-Intrusive**: Stored in user metadata without requiring database schema changes

## Technical Details

- User preferences override default colors using JavaScript object spread syntax
- Only non-default colors are stored to minimize data usage
- Graceful fallback to defaults if user preferences fail to load
- RESTful API design following Girder conventions
