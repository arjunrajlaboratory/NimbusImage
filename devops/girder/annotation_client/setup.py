#!/usr/bin/env python

from setuptools import setup

setup(
    name="annotation_client",
    version="0.1",
    description="Python Distribution Utilities",
    author="Adrien Boucaud",
    author_email="adrien.boucaud@kitware.com",
    url="https://github.com/boucaud/UPennContrast_annotation_client",
    packages=["annotation_client"],
    install_requires=["girder-client", "orjson>=3.10", "tifffile"],
)
