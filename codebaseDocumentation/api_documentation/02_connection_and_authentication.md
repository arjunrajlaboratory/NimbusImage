# Connection and Authentication

## Current Approach

All NimbusImage API access goes through `girder_client.GirderClient`. There are two authentication paths:

### 1. Interactive / Notebook Authentication (username + password)

```python
import girder_client

apiUrl = 'http://localhost:8080/api/v1'
client = girder_client.GirderClient(apiUrl=apiUrl)
user_id = client.authenticate(username='arjunraj', password='abc123')['_id']
token = client.token
```

Then pass `apiUrl` and `token` to NimbusImage clients:

```python
import annotation_client.annotations as annotations
import annotation_client.tiles as tiles

annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)
tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)
```

### 2. Worker Authentication (token passed via CLI args)

Workers receive `apiUrl` and `token` as command-line arguments from the job runner:

```python
parser = argparse.ArgumentParser()
parser.add_argument('--apiUrl', type=str, required=True)
parser.add_argument('--token', type=str, required=True)
parser.add_argument('--datasetId', type=str, required=False)
parser.add_argument('--request', type=str, required=True)
parser.add_argument('--parameters', type=str, required=True)

args = parser.parse_args()
params = json.loads(args.parameters)
```

## Listing Datasets

Datasets are Girder folders with `meta.subtype == 'contrastDataset'`. To list them interactively:

```python
# List all datasets for the authenticated user
datasets = {}
for folder in annotationClient.client.listFolder(user_id, 'user'):
    for dataset in annotationClient.client.listFolder(folder['_id']):
        datasets[dataset['name']] = dataset['_id']

# Result: {'Dataset Name': 'datasetId', ...}
```

Note: This uses `girder_client`'s `listFolder` method directly on the underlying `annotationClient.client` — there is no NimbusImage-specific dataset listing API yet.

## Accessing the Girder Client Directly

All NimbusImage client classes expose their underlying `girder_client.GirderClient` as `.client`:

```python
annotationClient.client   # girder_client.GirderClient instance
tileClient.client          # girder_client.GirderClient instance
workerClient.annotationClient.client  # nested access
```

This is used for operations not wrapped by NimbusImage, such as file upload:

```python
gc = tileClient.client
item = gc.uploadFileToFolder(datasetId, '/tmp/output.tiff')
gc.addMetadataToItem(item['itemId'], {'tool': 'MyWorker'})
```

## Dataset Metadata

A dataset (Girder folder) has metadata accessible via the Girder API:

```python
# Get dataset folder info
datasetInfo = tileClient.client.get(f'/folder/{datasetId}')
# datasetInfo['meta'] contains:
#   'subtype': 'contrastDataset'
#   'selectedLargeImageId': '...'  (which image item to display)
```

## Environment Conventions

For local testing, common environment variables:
- `NIMBUS_API_URL` — defaults to `http://localhost:8080/api/v1`
- `NIMBUS_TOKEN` — authentication token

## Design Notes for `ni` Package

The unified package should provide:

```python
import ni

# Option 1: username/password
client = ni.connect('http://localhost:8080/api/v1', username='user', password='pass')

# Option 2: token (for workers)
client = ni.connect('http://localhost:8080/api/v1', token='...')

# Option 3: from environment
client = ni.connect()  # reads NIMBUS_API_URL and NIMBUS_TOKEN

# List datasets
datasets = client.list_datasets()  # returns list of Dataset objects

# Access a specific dataset
ds = client.dataset('datasetId')
```
