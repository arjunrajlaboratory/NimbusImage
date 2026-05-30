// Single source of truth for static tour anchor names and trigger-event names.
// Components attach `:data-tour="TOUR_ANCHORS.x"`; YAML targets `[data-tour="x"]`.
// Trigger names are used by `v-tour-trigger` and by YAML `onTriggerEvent`.
// Data-dependent anchors (built at runtime via getTourAnchorId) are NOT listed
// here and are exempt from the static guard.

export const TOUR_ANCHORS = {
  // App.vue
  objectListButton: "object-list-button",
  filtersButton: "filters-button",
  snapshotsButton: "snapshots-button",
  settingsButton: "settings-button",
  analyzeButton: "analyze-button",
  helpButton: "help-button",
  chatButton: "chat-button",
  // ToolCreation.vue
  toolName: "tool-name",
  toolCreationAddToolButton: "tool-creation-add-tool-button",
  // AnnotationConfiguration.vue
  toolCreationLayerSelect: "tool-creation-layer-select",
  toolCreationTagPicker: "tool-creation-tag-picker",
  // Toolset.vue
  addTool: "add-tool",
  // ImageViewer.vue
  layerInfo: "layer-info",
  lockView: "lock-view",
  resetView: "reset-view",
  resetRotation: "reset-rotation",
  // NavigatorPanel.vue
  viewerToolbar: "viewer-toolbar",
  timelapseMode: "timelapse-mode",
  timelapseTags: "timelapse-tags",
  timelapseLabels: "timelapse-labels",
  // ZenodoImporter.vue
  zenodoImporterImportDataset: "zenodo-importer-import-dataset",
  // DisplayLayers.vue
  layerControls: "layer-controls",
  // ZenodoCommunityDisplay.vue
  zenodoCommunityDisplay: "zenodo-community-display",
  // DataIOMenu.vue
  dataIoButton: "data-io-button",
  // AnnotationList.vue
  annotationListContent: "annotation-list-content",
  // PropertyCreation.vue
  createPropertyHeader: "create-property-header",
  propertyTagPicker: "property-tag-picker",
  shapeSelection: "shape-selection",
  propertyAlgorithmSelect: "property-algorithm-select",
  createPropertyButton: "create-property-button",
  // Home.vue
  uploadFiles: "upload-files",
  trySampleDataset: "try-sample-dataset",
  configureDatasetButton: "configure-dataset-button",
  acceptDefaultsButton: "accept-defaults-button",
  // MultiSourceConfiguration.vue
  variables: "variables",
  assignments: "assignments",
  transcodeCheckbox: "transcode-checkbox",
  submitButton: "submit-button",
  // DatasetInfo.vue
  viewDatasetButton: "view-dataset-button",
  // NewDataset.vue
  datasetNameInput: "dataset-name-input",
  datasetDescriptionInput: "dataset-description-input",
  uploadButton: "upload-button",
} as const;

export const TOUR_TRIGGERS = {
  objectListButton: "object-list-button",
  filtersButton: "filters-button",
  snapshotsButton: "snapshots-button",
  settingsButton: "settings-button",
  analyzeButton: "analyze-button",
  helpButton: "help-button",
  chatButton: "chat-button",
  addTool: "add-tool",
  toolCreationAddToolButton: "tool-creation-add-tool-button",
  timelapseMode: "timelapse-mode",
  zenodoImporterImportDataset: "zenodo-importer-import-dataset",
  dataIoButton: "data-io-button",
  propertyTagPicker: "property-tag-picker",
  propertyAlgorithmSelect: "property-algorithm-select",
  createPropertyButton: "create-property-button",
  trySampleDataset: "try-sample-dataset",
  configureDataset: "configure-dataset",
  acceptDefaults: "accept-defaults",
  viewDatasetButton: "view-dataset-button",
  submitButton: "submit-button",
  uploadButton: "upload-button",
} as const;

// Set of all known static anchor names, for the static guard.
export const ALL_TOUR_ANCHORS = new Set<string>(Object.values(TOUR_ANCHORS));
export const ALL_TOUR_TRIGGERS = new Set<string>(Object.values(TOUR_TRIGGERS));
