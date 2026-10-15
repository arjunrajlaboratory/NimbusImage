"""Integration tests for Project mutators.

Each method's transport (query/form params vs JSON body) must match the
server route; the unit tests pin the request, these prove it lands.
"""

import secrets

import pytest

pytestmark = pytest.mark.integration


def test_project_mutators_round_trip(client, test_dataset):
    ds = test_dataset
    collection_id = ds.collections.list()[0].id
    project = client.create_project(
        f"ni-project-test-{secrets.token_hex(4)}"
    )
    try:
        project.add_dataset(ds.id)
        project.add_configuration(collection_id)
        project.set_status("exported")
        project.update_metadata({"title": "Round trip"})
        project.update(description="updated")

        fetched = client.project(project.id)
        assert ds.id in fetched.dataset_ids
        assert collection_id in fetched.configuration_ids
        assert fetched.status == "exported"
        assert fetched.publication_metadata["title"] == "Round trip"
        assert fetched.description == "updated"

        project.remove_dataset(ds.id)
        project.remove_configuration(collection_id)
        fetched = client.project(project.id)
        assert ds.id not in fetched.dataset_ids
        assert collection_id not in fetched.configuration_ids
    finally:
        project.delete()
