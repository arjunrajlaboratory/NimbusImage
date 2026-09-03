from setuptools import setup, find_packages

with open("README.rst", "r") as fh:
    long_desc = fh.read()

setup(
    name="upenncontrast_spatial",
    version="0.0.0",
    description=(
        "Girder plugin that stores and serves the per-cell expression "
        "table of a spatial-transcriptomics dataset (a zipped zarr store "
        "with AnnData layout) for NimbusImage"
    ),
    long_description=long_desc,
    author="Arjun Raj Laboratory",
    license="Apache Software License 2.0",
    classifiers=[
        "Development Status :: 2 - Pre-Alpha",
        "License :: OSI Approved :: Apache Software License",
        "Topic :: Scientific/Engineering",
        "Intended Audience :: Science/Research",
        "Natural Language :: English",
        "Programming Language :: Python",
    ],
    install_requires=[
        "girder[mount]>5",
        "girder-jobs>5",
        # The annotation plugin provides the dataset, annotation, property and
        # collection models this plugin reads and writes through. It is
        # installed from the sibling directory (Dockerfile, tox), never from
        # an index.
        "upenncontrast_annotation",
        "numpy",
        "orjson",
        # zarr 2 reads the zarr v2 stores anndata writes; large_image already
        # pins this major in the Girder image.
        "zarr>=2.18,<3",
    ],
    include_package_data=True,
    entry_points={
        "girder.plugin": [
            "upenncontrast_spatial = "
            "upenncontrast_spatial:UPennContrastSpatialPlugin"
        ]
    },
    packages=find_packages(),
    zip_safe=False,
)
