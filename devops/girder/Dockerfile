FROM girder/tox-and-node:latest

RUN virtualenv /venv --python=3.11
ENV PATH=/venv/bin:$PATH

RUN mkdir /mnt/fuse

RUN mkdir /src
WORKDIR /src

# Pin large_image to a known-good commit
# large_image master may pull girder 5.x which is incompatible
RUN git clone https://github.com/girder/large_image.git
WORKDIR /src/large_image
RUN git checkout 8f0eb29aaac4f0c9a17907c3f28537b1b84e9714
RUN pip install -e .[all] -r requirements-test.txt --find-links https://girder.github.io/large_image_wheels

# Pin girder to last 3.x commit (3.2.13.dev13) before 5.x migration
RUN pip install "girder[mount] @ git+https://github.com/girder/girder.git@f045c05e8"

COPY ./provision.py /src/provision.py
COPY ./girder.cfg /etc/girder.cfg

RUN pip install anthropic

COPY plugins/AnnotationPlugin /src/AnnotationPlugin
RUN pip install -e /src/AnnotationPlugin

COPY plugins/girder-claude-chat /src/girder-claude-chat
RUN pip install -e /src/girder-claude-chat

RUN girder build

ENTRYPOINT ["bash"]
