from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.models.user import User


class UserColors(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "user_colors"
        self.route("GET", (), self.getUserColors)
        self.route("PUT", (), self.setUserColors)

    @access.user
    @autoDescribeRoute(
        Description("Get user's color preferences")
        .responseClass("User")
    )
    def getUserColors(self):
        user = self.getCurrentUser()
        userModel = User()

        # Load the full user document with metadata
        fullUser = userModel.load(user['_id'], force=True)

        # Get color preferences from user metadata
        colors = fullUser.get('meta', {}).get('channelColors', {})
        return colors

    @access.user
    @autoDescribeRoute(
        Description("Set user's color preferences")
        .jsonParam('channelColors',
                   'A JSON object containing channel color mappings',
                   paramType='body', required=True, requireObject=True)
    )
    def setUserColors(self, channelColors):
        user = self.getCurrentUser()
        userModel = User()

        # Try using setMetadata if it exists
        if hasattr(userModel, 'setMetadata'):
            # Note: We pass channelColors directly, not wrapped in another
            # object
            userModel.setMetadata(user, channelColors)
            return {'success': True}

        # Fallback to direct manipulation
        # Initialize meta if it doesn't exist
        if 'meta' not in user:
            user['meta'] = {}

        # Set the channel colors in user metadata - merge with existing meta
        user['meta'].update(channelColors)

        # Save the user
        userModel.save(user)

        return {'success': True}
