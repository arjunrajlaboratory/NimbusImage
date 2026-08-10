# Test Scenarios

Step-by-step recipes for verifying backend functionality. Each scenario is self-contained.

## Setup: Get Auth Token

All scenarios start with authentication:

```bash
TOKEN=$(curl -s -u admin:password http://localhost:8080/api/v1/user/authentication | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken']['token'])")
echo "Token: $TOKEN"
```

## Setup: Find a Dataset ID

```bash
# List datasets to pick one
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.folder.find({'meta.subtype': 'contrastDataset'}, {name: 1, _id: 1}).limit(5).toArray()" --quiet
```

Set the dataset ID for subsequent commands:

```bash
DATASET_ID="paste-id-here"
```

## Scenario 1: Create and Delete a Test Annotation

Tests the basic annotation lifecycle via REST API.

```bash
# 1. Create an annotation
RESULT=$(curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"tags\": [\"test-scenario\"],
    \"shape\": \"point\",
    \"channel\": 0,
    \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0},
    \"coordinates\": [{\"x\": 100, \"y\": 200, \"z\": 0}],
    \"datasetId\": \"$DATASET_ID\"
  }" "http://localhost:8080/api/v1/upenn_annotation")

echo "Created: $RESULT"

# 2. Extract the annotation ID
ANN_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")
echo "Annotation ID: $ANN_ID"

# 3. Verify it exists
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ANN_ID" | python3 -m json.tool

# 4. Delete it
curl -s -X DELETE -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ANN_ID"

# 5. Verify deletion (should 400 or return empty)
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ANN_ID"
```

## Scenario 2: Create a Connection Between Annotations

Tests connection creation between two annotations.

```bash
# 1. Create two annotations
ANN1=$(curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"tags\": [\"test-parent\"],
    \"shape\": \"point\",
    \"channel\": 0,
    \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0},
    \"coordinates\": [{\"x\": 100, \"y\": 200, \"z\": 0}],
    \"datasetId\": \"$DATASET_ID\"
  }" "http://localhost:8080/api/v1/upenn_annotation" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")

ANN2=$(curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"tags\": [\"test-child\"],
    \"shape\": \"point\",
    \"channel\": 0,
    \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0},
    \"coordinates\": [{\"x\": 150, \"y\": 250, \"z\": 0}],
    \"datasetId\": \"$DATASET_ID\"
  }" "http://localhost:8080/api/v1/upenn_annotation" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")

echo "Parent: $ANN1, Child: $ANN2"

# 2. Create a connection
CONN=$(curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"parentId\": \"$ANN1\",
    \"childId\": \"$ANN2\",
    \"datasetId\": \"$DATASET_ID\",
    \"tags\": [\"test-connection\"]
  }" "http://localhost:8080/api/v1/annotation_connection")

echo "Connection: $CONN"
CONN_ID=$(echo "$CONN" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")

# 3. Verify connection exists
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_connection?datasetId=$DATASET_ID" | python3 -m json.tool

# 4. Cleanup
curl -s -X DELETE -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/annotation_connection/$CONN_ID"
curl -s -X DELETE -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ANN1"
curl -s -X DELETE -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ANN2"
```

## Scenario 3: Access Control - Create User and Share Dataset

Tests user creation and dataset sharing.

```bash
# 1. Create a test user
USER_RESULT=$(curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "login": "testuser",
    "email": "test@example.com",
    "firstName": "Test",
    "lastName": "User",
    "password": "testpass123"
  }' "http://localhost:8080/api/v1/user")

echo "User: $USER_RESULT"
USER_ID=$(echo "$USER_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")

# 2. Share a dataset with the test user (READ access)
curl -s -X PUT -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"access\": {\"users\": [{\"id\": \"$USER_ID\", \"level\": 0}]}, \"public\": false}" \
  "http://localhost:8080/api/v1/folder/$DATASET_ID/access"

# 3. Authenticate as the test user
TEST_TOKEN=$(curl -s -u testuser:testpass123 http://localhost:8080/api/v1/user/authentication | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken']['token'])")

# 4. Verify the test user can read annotations
curl -s -H "Girder-Token: $TEST_TOKEN" \
  "http://localhost:8080/api/v1/upenn_annotation?datasetId=$DATASET_ID" | python3 -c "import sys,json; data=json.load(sys.stdin); print(f'Can access: {len(data)} annotations')"

# 5. Verify the test user CANNOT write (should fail)
curl -s -X POST -H "Girder-Token: $TEST_TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"tags\": [\"test\"],
    \"shape\": \"point\",
    \"channel\": 0,
    \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0},
    \"coordinates\": [{\"x\": 100, \"y\": 200, \"z\": 0}],
    \"datasetId\": \"$DATASET_ID\"
  }" "http://localhost:8080/api/v1/upenn_annotation"

# 6. Cleanup: delete test user (as admin)
curl -s -X DELETE -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/user/$USER_ID"
```

## Scenario 4: Batch Operations

Tests bulk create and delete endpoints.

```bash
# 1. Batch create 3 annotations
BATCH_RESULT=$(curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "[
    {\"tags\": [\"batch-test\"], \"shape\": \"point\", \"channel\": 0, \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0}, \"coordinates\": [{\"x\": 10, \"y\": 20, \"z\": 0}], \"datasetId\": \"$DATASET_ID\"},
    {\"tags\": [\"batch-test\"], \"shape\": \"point\", \"channel\": 0, \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0}, \"coordinates\": [{\"x\": 30, \"y\": 40, \"z\": 0}], \"datasetId\": \"$DATASET_ID\"},
    {\"tags\": [\"batch-test\"], \"shape\": \"point\", \"channel\": 0, \"location\": {\"Time\": 0, \"Z\": 0, \"XY\": 0}, \"coordinates\": [{\"x\": 50, \"y\": 60, \"z\": 0}], \"datasetId\": \"$DATASET_ID\"}
  ]" "http://localhost:8080/api/v1/upenn_annotation/multiple")

echo "Batch created: $BATCH_RESULT"

# 2. Extract IDs
IDS=$(echo "$BATCH_RESULT" | python3 -c "import sys,json; ids=json.load(sys.stdin); print(','.join([a['_id'] for a in ids]))")
echo "Created IDs: $IDS"

# 3. Verify count via MongoDB
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments({tags: 'batch-test', datasetId: ObjectId('$DATASET_ID')})" --quiet

# 4. Batch delete
ID_ARRAY=$(echo "$BATCH_RESULT" | python3 -c "import sys,json; ids=json.load(sys.stdin); print(json.dumps({'ids': [a['_id'] for a in ids]}))")
curl -s -X DELETE -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "$ID_ARRAY" "http://localhost:8080/api/v1/upenn_annotation/multiple"

# 5. Verify cleanup
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments({tags: 'batch-test', datasetId: ObjectId('$DATASET_ID')})" --quiet
```

## Scenario 5: Verify Property Computation

Tests that a property can be computed for annotations.

```bash
# 1. List existing properties for the dataset
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property?datasetId=$DATASET_ID" | python3 -m json.tool

# 2. Pick a property ID from the output
PROPERTY_ID="paste-property-id-here"

# 3. Trigger computation
curl -s -X POST -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property/$PROPERTY_ID/compute?datasetId=$DATASET_ID"

# 4. Check job status
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.job.find({}, {title: 1, status: 1}).sort({updated: -1}).limit(3).toArray()" --quiet

# 5. After job completes (status: 3), check property values
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property_values?propertyId=$PROPERTY_ID&datasetId=$DATASET_ID" | python3 -c "import sys,json; data=json.load(sys.stdin); print(f'Property values: {len(data)}')"
```

## Scenario 6: Export Data

Tests JSON and CSV export endpoints.

```bash
# 1. Export as JSON
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/export/json?datasetId=$DATASET_ID" | python3 -m json.tool | head -50

# 2. Export as CSV
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/export/csv?datasetId=$DATASET_ID" | head -10
```
