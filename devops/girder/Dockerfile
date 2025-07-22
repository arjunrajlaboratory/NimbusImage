FROM girder/tox-and-node:latest

RUN virtualenv /venv --python=3.11
ENV PATH=/venv/bin:$PATH

RUN mkdir /mnt/fuse

RUN mkdir /src
WORKDIR /src

RUN git clone https://github.com/girder/girder.git
WORKDIR /src/girder
RUN pip install -e .

WORKDIR /src

RUN git clone https://github.com/girder/large_image.git
WORKDIR /src/large_image
RUN pip install -e .[all] -r requirements-test.txt --find-links https://girder.github.io/large_image_wheels
RUN pip install girder[mount] girder-user-quota git+https://github.com/DigitalSlideArchive/import-tracker.git

COPY ./provision.py /src/provision.py
COPY ./girder.cfg /etc/girder.cfg

RUN pip install fastjsonschema
RUN pip install anthropic

COPY plugins/AnnotationPlugin /src/AnnotationPlugin
RUN pip install -e /src/AnnotationPlugin

COPY plugins/girder-claude-chat /src/girder-claude-chat
RUN pip install -e /src/girder-claude-chat

RUN girder build

ENTRYPOINT ["bash"]
