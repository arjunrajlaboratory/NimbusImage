from setuptools import setup, find_packages

with open("README.rst", "r") as fh:
    long_desc = fh.read()

setup(
    name="nimbus_mcp_oauth",
    version="0.0.0",
    description=(
        "Girder plugin: the OAuth 2.1 authorization server that lets Claude "
        "connectors use the NimbusImage MCP server as the signed-in user"
    ),
    long_description=long_desc,
    author="Arjun Raj Laboratory",
    license="Apache Software License 2.0",
    classifiers=[
        "Development Status :: 2 - Pre-Alpha",
        "License :: OSI Approved :: Apache Software License",
        "Natural Language :: English",
        "Programming Language :: Python",
    ],
    install_requires=[
        "girder>5",
        # Fetching Client ID Metadata Documents; already in the Girder image.
        "requests",
    ],
    include_package_data=True,
    entry_points={
        "girder.plugin": [
            "nimbus_mcp_oauth = nimbus_mcp_oauth:McpOAuthPlugin"
        ]
    },
    packages=find_packages(),
    zip_safe=False,
)
