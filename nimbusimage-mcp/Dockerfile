# NimbusImage MCP server. Built by docker-compose.yaml's `mcp` service
# (profile "mcp"), which passes the nimbusimage package source as the
# named build context "nimbusimage" so the image matches this checkout.
FROM python:3.12-slim

COPY --from=nimbusimage pyproject.toml README.md /src/nimbusimage/
COPY --from=nimbusimage nimbusimage /src/nimbusimage/nimbusimage
COPY pyproject.toml README.md /src/nimbusimage-mcp/
COPY nimbusimage_mcp /src/nimbusimage-mcp/nimbusimage_mcp
RUN pip install --no-cache-dir /src/nimbusimage /src/nimbusimage-mcp

# The server holds no credentials and writes nothing; run unprivileged.
USER nobody
ENV NI_MCP_HOST=0.0.0.0 \
    NI_MCP_PORT=8000
EXPOSE 8000
CMD ["nimbusimage-mcp"]
