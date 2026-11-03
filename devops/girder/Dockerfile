# The Rust BSON -> JSON transcoder the annotation plugin streams large
# annotation reads through (plugins/AnnotationPlugin/bson-json-native). Built
# as a wheel in its own stage, so no Rust toolchain reaches the final image.
# Same base as the final stage: that image is amd64-only, and a builder from
# a multi-arch image would build an arm64 wheel on Apple Silicon that the
# (emulated) amd64 image can't install.
FROM girder/tox-and-node-lts:latest AS bson-json-native
ARG RUST_VERSION=1.99.1
ARG MATURIN_VERSION=1.16.0
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    --default-toolchain $RUST_VERSION --no-modify-path
RUN virtualenv /maturin --python=3.11 \
    && /maturin/bin/pip install --no-cache-dir maturin==$MATURIN_VERSION
COPY plugins/AnnotationPlugin/bson-json-native /build
WORKDIR /build
# abi3: one wheel for every CPython >= 3.9. "linux" skips the manylinux
# audit; the wheel only ever installs into the image below.
RUN /maturin/bin/maturin build --release --locked --compatibility linux \
    --out /wheels


FROM girder/tox-and-node-lts:latest

RUN virtualenv /venv --python=3.11
ENV PATH=/venv/bin:$PATH

RUN mkdir /mnt/fuse

RUN mkdir /src
WORKDIR /src

COPY ./provision.py /src/provision.py

# Optional for the plugin: without it, reads fall back to decoding in Python
# (the same bytes, ~4x slower for large annotation lists).
COPY --from=bson-json-native /wheels /tmp/bson-json-native
RUN pip install --no-cache-dir /tmp/bson-json-native/*.whl \
    && python -c "import bson_json_native; bson_json_native.transcode(b'')" \
    && rm -rf /tmp/bson-json-native

COPY plugins/AnnotationPlugin /src/AnnotationPlugin
RUN pip install -e /src/AnnotationPlugin

COPY plugins/girder-claude-chat /src/girder-claude-chat
RUN pip install -e /src/girder-claude-chat

COPY plugins/SpatialPlugin /src/SpatialPlugin
RUN pip install -e /src/SpatialPlugin

# OAuth for Claude connectors to the MCP server; off until the
# mcp_oauth.enabled setting is true.
COPY plugins/McpOAuthPlugin /src/McpOAuthPlugin
RUN pip install -e /src/McpOAuthPlugin

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
