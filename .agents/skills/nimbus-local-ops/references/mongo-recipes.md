# MongoDB Recipes

All commands use this pattern:

```bash
docker exec upenncontrast-mongodb-1 mongosh girder --eval "QUERY" --quiet
```

## Document Shapes

### upenn_annotation

```javascript
{
  _id: ObjectId,
  tags: ["tag1", "tag2"],
  shape: "point" | "line" | "polygon" | "rectangle" | "circle",
  channel: 0,
  location: { Time: 0, Z: 0, XY: 0 },
  coordinates: [{ x: Number, y: Number, z: Number }],
  datasetId: ObjectId,
  creatorId: ObjectId
}
```

### folder (Dataset)

```javascript
{
  _id: ObjectId,
  name: "Dataset Name",
  parentId: ObjectId,
  parentCollection: "folder",
  meta: {
    subtype: "contrastDataset",
    // ... image metadata (channels, frames, etc.)
  }
}
```

### upenn_collection (Configuration)

```javascript
{
  _id: ObjectId,
  name: "Config Name",
  datasetId: ObjectId,
  meta: {
    // layers, tools, scales, etc.
  }
}
```

### annotation_connection

```javascript
{
  _id: ObjectId,
  parentId: ObjectId,  // parent annotation
  childId: ObjectId,   // child annotation
  datasetId: ObjectId,
  tags: ["connection-tag"],
  creatorId: ObjectId
}
```

### dataset_view

```javascript
{
  _id: ObjectId,
  datasetId: ObjectId,
  configurationId: ObjectId,
  creatorId: ObjectId,
  lastLocation: { x: Number, y: Number, zoom: Number },
  // per-user contrast overrides, etc.
}
```

### annotation_property

```javascript
{
  _id: ObjectId,
  name: "Property Name",
  image: "docker/image:tag",
  datasetId: ObjectId,
  tags: { tags: ["tag"], exclusive: false },
  shape: "point" | "polygon" | ...,
  independentVariables: []
}
```

### annotation_property_values

```javascript
{
  _id: ObjectId,
  annotationId: ObjectId,
  propertyId: ObjectId,
  values: { "PropertyName": 1234.5 }
}
```

### upenn_project

```javascript
{
  _id: ObjectId,
  name: "Project Name",
  description: "Description",
  datasetIds: [ObjectId],
  collectionIds: [ObjectId],
  creatorId: ObjectId
}
```

## Inspection Queries

### Counting

```bash
# Total annotations
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments()" --quiet

# Annotations in a specific dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments({datasetId: ObjectId('DATASET_ID')})" --quiet

# Annotations by shape in a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.aggregate([{'\$match': {datasetId: ObjectId('DATASET_ID')}}, {'\$group': {_id: '\$shape', count: {'\$sum': 1}}}]).toArray()" --quiet

# Connections count
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.annotation_connection.countDocuments({datasetId: ObjectId('DATASET_ID')})" --quiet
```

### Finding

```bash
# Find annotations with a specific tag
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.find({datasetId: ObjectId('DATASET_ID'), tags: 'mytag'}, {_id: 1, tags: 1, shape: 1}).limit(5).toArray()" --quiet

# Find all distinct tags in a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.distinct('tags', {datasetId: ObjectId('DATASET_ID')})" --quiet

# Find all distinct shapes in a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.distinct('shape', {datasetId: ObjectId('DATASET_ID')})" --quiet

# List all datasets
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.folder.find({'meta.subtype': 'contrastDataset'}, {name: 1, _id: 1}).toArray()" --quiet

# List all projects
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_project.find({}, {name: 1}).toArray()" --quiet

# Find configs for a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_collection.find({datasetId: ObjectId('DATASET_ID')}, {name: 1}).toArray()" --quiet

# Find views for a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.dataset_view.find({datasetId: ObjectId('DATASET_ID')}).toArray()" --quiet

# Find property definitions for a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.annotation_property.find({datasetId: ObjectId('DATASET_ID')}, {name: 1, shape: 1}).toArray()" --quiet
```

### Aggregation

```bash
# Annotation count per tag
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.aggregate([{'\$match': {datasetId: ObjectId('DATASET_ID')}}, {'\$unwind': '\$tags'}, {'\$group': {_id: '\$tags', count: {'\$sum': 1}}}, {'\$sort': {count: -1}}]).toArray()" --quiet

# Annotations per time point
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.aggregate([{'\$match': {datasetId: ObjectId('DATASET_ID')}}, {'\$group': {_id: '\$location.Time', count: {'\$sum': 1}}}, {'\$sort': {_id: 1}}]).toArray()" --quiet
```

## Manipulation Queries

### Insert Test Data

```bash
# Insert a test annotation
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.insertOne({tags: ['test'], shape: 'point', channel: 0, location: {Time: 0, Z: 0, XY: 0}, coordinates: [{x: 100, y: 200, z: 0}], datasetId: ObjectId('DATASET_ID'), creatorId: ObjectId('USER_ID')})" --quiet
```

### Bulk Updates

```bash
# Add a tag to all annotations in a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.updateMany({datasetId: ObjectId('DATASET_ID')}, {'\$addToSet': {tags: 'new-tag'}})" --quiet

# Remove a tag from all annotations
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.updateMany({datasetId: ObjectId('DATASET_ID')}, {'\$pull': {tags: 'old-tag'}})" --quiet
```

### Cleanup

```bash
# Delete test annotations (by tag)
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.deleteMany({tags: 'test', datasetId: ObjectId('DATASET_ID')})" --quiet

# Delete all property values for a property
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.annotation_property_values.deleteMany({propertyId: ObjectId('PROPERTY_ID')})" --quiet
```

## Cross-Referencing

### Navigate Dataset Relationships

```bash
# Given a dataset ID, find its configs, views, annotations, and connections
DATASET_ID="YOUR_DATASET_ID"

# Configs
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_collection.find({datasetId: ObjectId('$DATASET_ID')}, {name: 1}).toArray()" --quiet

# Views
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.dataset_view.find({datasetId: ObjectId('$DATASET_ID')}, {configurationId: 1, creatorId: 1}).toArray()" --quiet

# Annotation count
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments({datasetId: ObjectId('$DATASET_ID')})" --quiet

# Connection count
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.annotation_connection.countDocuments({datasetId: ObjectId('$DATASET_ID')})" --quiet

# Properties
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.annotation_property.find({datasetId: ObjectId('$DATASET_ID')}, {name: 1}).toArray()" --quiet
```

### Find Who Has Access

```bash
# Check access control on a dataset (folder)
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.folder.findOne({_id: ObjectId('DATASET_ID')}, {access: 1, public: 1})" --quiet

# Check access on a view
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.dataset_view.findOne({_id: ObjectId('VIEW_ID')}, {access: 1, public: 1})" --quiet
```
