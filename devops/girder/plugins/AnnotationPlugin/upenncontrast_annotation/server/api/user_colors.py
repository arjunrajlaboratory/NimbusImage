from dataclasses import dataclass
from typing import Dict

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource

from ..models.userColors import UserColors as UserColorsModel


@dataclass
class UserColorPreferences:
    """Response dataclass for user color preferences."""
    channelColors: Dict[str, str]


class UserColors(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "user_colors"
        self.route("GET", (), self.getUserColors)
        self.route("PUT", (), self.setUserColors)

        # Initialize the model
        self.userColorsModel = UserColorsModel()

    @access.user
    @autoDescribeRoute(
        Description("Get user's color preferences")
        .responseClass("UserColorPreferences")
    )
    def getUserColors(self):
        user = self.getCurrentUser()
        channelColors = self.userColorsModel.getUserColors(user)
        return UserColorPreferences(channelColors=channelColors)

    @access.user
    @autoDescribeRoute(
        Description("Set user's color preferences")
        .jsonParam('body', 'Request body containing channelColors object',
                   paramType='body', required=True, requireObject=True)
    )
    def setUserColors(self, body):
        user = self.getCurrentUser()
        # Extract channelColors from the request body
        channelColors = body.get('channelColors', {})
        self.userColorsModel.setUserColors(user, channelColors)
        return {'success': True}
