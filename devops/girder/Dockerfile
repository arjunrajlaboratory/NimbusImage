FROM girder/tox-and-node-lts:latest

RUN virtualenv /venv --python=3.11
ENV PATH=/venv/bin:$PATH

RUN mkdir /mnt/fuse

RUN mkdir /src
WORKDIR /src

# Pin Girder explicitly. Investigating a login-persistence regression that
# coincides with recent Girder 5.0.x point releases; the plugins specify
# girder[mount]>5 which would otherwise pull whatever 5.x is current at
# build time.
RUN pip install "girder[mount]==5.0.3"

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
