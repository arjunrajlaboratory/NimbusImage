"""Integration tests for worker discovery and execution.

These tests verify the full worker lifecycle:
1. Discover available workers via GET /worker_interface/available
2. Fetch worker parameter interface
3. Submit annotation worker job
4. Track job to completion
5. Verify annotations were created
6. Clean up test annotations
"""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def client():
    import os
    api_url = os.environ.get("NI_API_URL", "http://localhost:8080/api/v1")
    username = os.environ.get("NI_TEST_USER", "admin")
    password = os.environ.get("NI_TEST_PASS", "password")
    return ni.connect(api_url, username=username, password=password)


@pytest.fixture(scope="module")
def dataset(client):
    """Find a dataset with image data for worker testing."""
    datasets = client.list_datasets()
    if not datasets:
        pytest.skip("No datasets available")
    # Use the first dataset
    ds = client.dataset(datasets[0]["_id"])
    try:
        _ = ds.shape  # Ensure it has image data
    except Exception:
        pytest.skip("No dataset with image data found")
    return ds


class TestWorkerDiscovery:
    def test_list_workers(self, client):
        workers = client.list_workers()
        assert isinstance(workers, dict)
        assert len(workers) > 0
        # Each entry should have labels
        for image, labels in workers.items():
            assert isinstance(labels, dict)
            assert "isUPennContrastWorker" in labels

    def test_get_worker_interface(self, client):
        workers = client.list_workers()
        # Find an annotation worker (random_squares is always available)
        image = None
        for name in workers:
            if "random_squares" in name and ":test" not in name:
                image = name
                break
        if image is None:
            pytest.skip("random_squares worker not available")

        iface = client.get_worker_interface(image)
        assert iface is not None
        assert isinstance(iface, dict)
        assert len(iface) > 0


class TestAnnotationWorkerExecution:
    def test_run_random_squares(self, client, dataset):
        """Full e2e: run random_squares, verify annotations, clean up."""
        workers = client.list_workers()
        image = None
        for name in workers:
            if "random_squares" in name and ":test" not in name:
                image = name
                break
        if image is None:
            pytest.skip("random_squares worker not available")

        count_before = dataset.annotations.count()

        job = dataset.annotations.compute(
            image=image,
            channel=0,
            tags=["integration-test-squares"],
            worker_interface={
                "Number of squares": 3,
                "Square size": 10,
            },
            name="integration_test",
        )

        assert job.id is not None
        success = job.wait(poll_interval=2.0, timeout=120, verbose=False)
        assert success, f"Job failed: {job.log}"

        count_after = dataset.annotations.count()
        assert count_after > count_before

        # Clean up
        test_anns = dataset.annotations.list(
            tags=["integration-test-squares"]
        )
        assert len(test_anns) > 0
        dataset.annotations.delete_many(
            [a.id for a in test_anns]
        )
        assert dataset.annotations.count() == count_before
