"""
User color preferences model for storing channel color mappings.

This model handles validation and storage of user-specific color preferences
for fluorescence channels in the user's metadata.
"""

import fastjsonschema

from girder.models.model_base import Model
from girder.models.user import User
from girder.exceptions import ValidationException

from ..helpers.fastjsonschema import customJsonSchemaCompile


class UserColorsSchema:
    """JSON schema for validating channel color mappings."""

    channelColorsSchema = {
        "$schema": "http://json-schema.org/draft-04/schema#",
        "type": "object",
        "patternProperties": {
            "^.+$": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
            }
        },
        "additionalProperties": False,
        "description": ("Channel color mappings where keys are channel names "
                        "(any non-empty string) and values are hex colors")
    }


class UserColors(Model):
    """Model for managing user color preferences."""

    def __init__(self):
        super().__init__()

        # Initialize JSON schema validator
        self.jsonValidate = customJsonSchemaCompile(
            UserColorsSchema.channelColorsSchema)

    def initialize(self):
        """Initialize the UserColors model."""
        self.name = 'user_colors'
        # No database indices needed for this model since we store data in
        # user metadata

    def validateChannelColors(self, channelColors):
        """Validate channel colors against the JSON schema."""
        try:
            self.jsonValidate(channelColors)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp) from exp
        return channelColors

    def getUserColors(self, user):
        """Get user's color preferences from metadata."""
        # Load the full user document with metadata
        fullUser = User().load(user['_id'], force=True)

        # Get color preferences from user metadata
        return fullUser.get('meta', {}).get('channelColors', {})

    def setUserColors(self, user, channelColors):
        """Set user's color preferences in metadata."""
        # Validate the channel colors format (business logic validation)
        self.validateChannelColors(channelColors)

        # Fallback: handle meta field initialization and save
        if 'meta' not in user:
            user['meta'] = {}

        user['meta']['channelColors'] = channelColors
        User().save(user)
