"""
Zenodo API client for uploading depositions.

Handles the full Zenodo deposit workflow:
1. Create deposition (or new version of existing)
2. Upload files via bucket API (supports up to 50GB per file)
3. Set metadata
4. Publish (mints DOI, irreversible)

Supports both production (zenodo.org) and sandbox
(sandbox.zenodo.org) environments.

Also provides shared helpers used by both the REST
endpoints and the background job module.
"""

import datetime
import logging
import requests
from urllib.parse import quote

from girder.models.user import User

from ..api.zenodo_credentials import decrypt_token
from ..models.project import Project as ProjectModel

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
            del_resp = self.session.delete(
                self._url(
                    f"deposit/depositions/{deposition_id}"
                    f"/files/{f['id']}"
                ),
            )
            self._check(del_resp, (204,))

    def upload_file(self, bucket_url, filename, data,
                    content_type="application/octet-stream",
                    size=None):
        """Upload a file to the deposition bucket.

        Uses the new bucket API (PUT) which supports files
        up to 50GB.

        :param bucket_url: The bucket URL from deposition
            links.
        :param filename: Target filename in the deposition.
        :param data: Bytes, file-like object, or generator
            yielding bytes.
        :param content_type: MIME type for the upload.
        :param size: File size in bytes. When provided,
            sets Content-Length so Zenodo records the
            correct file size.
        :returns: Upload response dict with checksum etc.
        """
        # URL-encode the filename to handle special chars
        # safe='' ensures / is also encoded
        url = f"{bucket_url}/{quote(filename, safe='')}"
        headers = {"Content-Type": content_type}
        if size is not None:
            headers["Content-Length"] = str(size)
        resp = self.session.put(
            url,
            data=data,
            headers=headers,
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


# --- Shared helpers for REST endpoints and job module ---

def get_zenodo_client_for_user(user):
    """Build a ZenodoClient from a user's stored token.

    :param user: Girder user document (or dict with _id).
    :returns: ZenodoClient instance.
    :raises ValueError: If no token or decryption fails.
    """
    full_user = User().load(user['_id'], force=True)
    zenodo_meta = full_user.get(
        'meta', {}
    ).get('zenodo', {})
    encrypted = zenodo_meta.get('encryptedToken')

    if not encrypted:
        raise ValueError(
            "No Zenodo token configured."
        )

    token = decrypt_token(encrypted)
    if not token:
        raise ValueError(
            "Failed to decrypt Zenodo token."
        )

    sandbox = zenodo_meta.get('sandbox', False)
    return ZenodoClient(token, sandbox=sandbox)


def update_zenodo_meta(project_id, zenodo_data,
                       project_model=None):
    """Update the project's meta.zenodo field.

    :param project_id: The project ID.
    :param zenodo_data: Dict of zenodo fields to update.
    :param project_model: Optional ProjectModel instance
        (avoids re-instantiation in loops).
    """
    if project_model is None:
        project_model = ProjectModel()
    project = project_model.load(
        project_id, force=True
    )
    if not project:
        return
    existing = project['meta'].get('zenodo', {})
    existing.update(zenodo_data)
    project['meta']['zenodo'] = existing
    project['updated'] = datetime.datetime.utcnow()
    project_model.save(project)
