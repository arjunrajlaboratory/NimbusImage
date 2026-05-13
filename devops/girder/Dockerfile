FROM girder/tox-and-node-lts:latest

# fusepy (pulled in by girder[mount]) dlopens libfuse.so.2 at module import
# time. Recent rebuilds of the base image dropped libfuse2 because Debian's
# `fuse` apt package became a transitional alias for fuse3, breaking
# `girder mount` and emitting an entry-point load warning on every CLI call.
# Install libfuse2 explicitly until fusepy/Girder support libfuse3.
# See https://github.com/girder/girder/issues/3814
RUN apt-get update \
    && apt-get install -y --no-install-recommends libfuse2 \
    && rm -rf /var/lib/apt/lists/*

RUN virtualenv /venv --python=3.11
ENV PATH=/venv/bin:$PATH

RUN mkdir /mnt/fuse

RUN mkdir /src
WORKDIR /src

COPY ./provision.py /src/provision.py

COPY plugins/AnnotationPlugin /src/AnnotationPlugin
RUN pip install -e /src/AnnotationPlugin

COPY plugins/girder-claude-chat /src/girder-claude-chat
RUN pip install -e /src/girder-claude-chat

# Use latest version of large_image
RUN git clone -b girder-5 --single-branch https://github.com/girder/large_image
WORKDIR /src/large_image
RUN pip install --no-cache-dir --find-links https://girder.github.io/large_image_wheels -e .[memcached] -rrequirements-dev.txt

WORKDIR /src/large_image/girder/girder_large_image/web_client
RUN npm ci || npm install && npm run build

WORKDIR /src/large_image/girder_annotation/girder_large_image_annotation/web_client
RUN npm ci || npm install && npm run build

WORKDIR /src/large_image/sources/dicom/large_image_source_dicom/web_client
RUN npm ci || npm install && npm run build


ENTRYPOINT ["bash"]
