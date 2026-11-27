import type { AxiosInstance } from "axios";

// Girder zstd-compresses an API response only when the request carries
// ?compress=zstd (and the browser's Accept-Encoding includes zstd), see
// server/helpers/compression.py. Workers and the MCP server, which reach
// Girder over the AWS private network where compression costs more than it
// saves, don't send it. It is a query parameter, not a header, so it needs no
// CORS allow-list entry. Girder removes it before the endpoint runs.
export const COMPRESSION_PARAM = "compress";
export const COMPRESSION_VALUE = "zstd";

/** Add the compression opt-in to every request `axios` sends. */
export function requestCompressedResponses(axios: AxiosInstance) {
  axios.interceptors.request.use((config) => {
    if (config.params instanceof URLSearchParams) {
      config.params.set(COMPRESSION_PARAM, COMPRESSION_VALUE);
    } else {
      config.params = {
        ...config.params,
        [COMPRESSION_PARAM]: COMPRESSION_VALUE,
      };
    }
    return config;
  });
}

/** `url` with the compression opt-in, for requests made with fetch. */
export function withCompressionOptIn(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${COMPRESSION_PARAM}=${COMPRESSION_VALUE}`;
}
