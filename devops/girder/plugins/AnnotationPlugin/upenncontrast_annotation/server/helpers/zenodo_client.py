"""
Zenodo API client for uploading depositions.

Handles the full Zenodo deposit workflow:
1. Create deposition (or new version of existing)
2. Upload files via bucket API (supports up to 50GB per file)
3. Set metadata
4. Publish (mints DOI, irreversible)

Supports both production (zenodo.org) and sandbox
(sandbox.zenodo.org) environments.
"""

import logging
import requests
from urllib.parse import quote

log = logging.getLogger(__name__)

ZENODO_BASE = "https://zenodo.org"
ZENODO_SANDBOX_BASE = "https://sandbox.zenodo.org"


class ZenodoError(Exception):
    """Error from the Zenodo API."""

    def __init__(self, message, status_code=None, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class ZenodoClient:
    """Thin wrapper around the Zenodo REST API."""

    def __init__(self, token, sandbox=False):
        self.token = token
        self.base_url = (
            ZENODO_SANDBOX_BASE if sandbox else ZENODO_BASE
        )
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}"
        })

    def _url(self, path):
        return f"{self.base_url}/api/{path}"

    def _check(self, resp, expected=(200, 201, 202)):
        if resp.status_code not in expected:
            msg = (
                f"Zenodo API error {resp.status_code}: "
                f"{resp.text[:500]}"
            )
            raise ZenodoError(
                msg,
                status_code=resp.status_code,
                response=resp,
            )
        return resp

    def validate_token(self):
        """Check that the token is valid.

        Returns the deposit list (empty or not) on success.
        Raises ZenodoError on auth failure.
        """
        resp = self.session.get(
            self._url("deposit/depositions"),
            params={"size": 1},
        )
        self._check(resp, expected=(200,))
        return True

    def create_deposition(self):
        """Create a new empty deposition.

        Returns dict with 'id', 'links.bucket', etc.
        """
        resp = self.session.post(
            self._url("deposit/depositions"),
            json={},
        )
        return self._check(resp, (201,)).json()

    def create_new_version(self, deposition_id):
        """Create a new version of an existing published
        deposition.

        Returns the new draft deposition dict.
        """
        resp = self.session.post(
            self._url(
                f"deposit/depositions/{deposition_id}"
                f"/actions/newversion"
            ),
        )
        data = self._check(resp).json()
        # The response contains a link to the new draft
        new_url = data["links"]["latest_draft"]
        resp2 = self.session.get(new_url)
        return self._check(resp2).json()

    def delete_all_files(self, deposition_id):
        """Delete all files from a deposition draft.

        Useful when creating a new version (which copies
        old files) and we want to upload fresh files.
        """
        resp = self.session.get(
            self._url(
                f"deposit/depositions/{deposition_id}/files"
            ),
        )
        files = self._check(resp).json()
        for f in files:
            self.session.delete(
                self._url(
                    f"deposit/depositions/{deposition_id}"
                    f"/files/{f['id']}"
                ),
            )

    def upload_file(self, bucket_url, filename, stream,
                    content_type="application/octet-stream"):
        """Upload a file to the deposition bucket.

        Uses the new bucket API (PUT) which supports files
        up to 50GB. Streams data directly.

        :param bucket_url: The bucket URL from deposition
            links.
        :param filename: Target filename in the deposition.
        :param stream: File-like object or generator
            yielding bytes.
        :param content_type: MIME type for the upload.
        :returns: Upload response dict with checksum etc.
        """
        # URL-encode the filename to handle special chars
        # safe='' ensures / is also encoded
        url = f"{bucket_url}/{quote(filename, safe='')}"
        resp = self.session.put(
            url,
            data=stream,
            headers={"Content-Type": content_type},
        )
        return self._check(resp, (200, 201)).json()

    def set_metadata(self, deposition_id, metadata):
        """Set deposition metadata.

        :param deposition_id: The deposition ID.
        :param metadata: Dict following Zenodo metadata
            schema. Required keys: upload_type, title,
            description, creators, publication_date,
            access_right.
        """
        resp = self.session.put(
            self._url(
                f"deposit/depositions/{deposition_id}"
            ),
            json={"metadata": metadata},
        )
        return self._check(resp).json()

    def publish(self, deposition_id):
        """Publish a deposition. Mints a DOI.

        WARNING: This is irreversible. The record cannot
        be deleted after publishing.

        :returns: Published deposition dict with DOI.
        """
        resp = self.session.post(
            self._url(
                f"deposit/depositions/{deposition_id}"
                f"/actions/publish"
            ),
        )
        return self._check(resp, (202,)).json()

    def discard(self, deposition_id):
        """Discard an unpublished deposition draft.

        :returns: Response dict.
        """
        resp = self.session.post(
            self._url(
                f"deposit/depositions/{deposition_id}"
                f"/actions/discard"
            ),
        )
        return self._check(resp, (201,)).json()

    def get_deposition(self, deposition_id):
        """Get deposition details.

        :returns: Deposition dict.
        """
        resp = self.session.get(
            self._url(
                f"deposit/depositions/{deposition_id}"
            ),
        )
        return self._check(resp).json()
