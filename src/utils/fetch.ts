import { RestClientInstance } from "@/girder";
import progressStore from "@/store/progress";
import { logError, logWarning } from "@/utils/log";
import { AxiosRequestConfig } from "axios";

// Define which endpoints support cursor pagination
const CURSOR_SUPPORTED_ENDPOINTS = [
  "upenn_annotation",
  "annotation_connection",
  "annotation_property_values",
];

export async function fetchAllPages(
  client: RestClientInstance,
  endpoint: string,
  baseFormData?: AxiosRequestConfig,
  firstPage?: number,
) {
  // Auto-detect: use cursor for supported endpoints, offset for others
  let useCursor = CURSOR_SUPPORTED_ENDPOINTS.includes(endpoint);

  // Only capture progress for these endpoints
  const PROGRESS_ENDPOINTS = [
    "upenn_annotation",
    "annotation_connection",
    "annotation_property_values",
  ];

  const progressId = PROGRESS_ENDPOINTS.includes(endpoint)
    ? await progressStore.create({ endpoint })
    : null;

  const pages: any[] = [];
  let totalCount = -1;
  const baseParams = {
    limit: 100000,
    sort: "_id",
    ...baseFormData?.params,
  };
  const pageSize = baseParams.limit;

  let downloaded = 0;
  let requestCount = 0;

  if (useCursor) {
    // Sequential cursor-based pagination (fast and consistent)
    let afterId: string | null = null;
    let hasMore = true;
    let firstRequest = true;
    let lastCursor: string | null = null;
    let cursorStuckCount = 0;
    const MAX_REQUESTS = 100; // Safety limit to prevent infinite loops
    const MAX_CURSOR_STUCK = 3; // If cursor doesn't change 3 times, fall back to offset

    try {
      while (hasMore && requestCount < MAX_REQUESTS) {
        requestCount++;
        const formData: AxiosRequestConfig = {
          ...baseFormData,
          params: {
            ...baseParams,
            ...(afterId ? { afterId } : {}),
          },
        };

        const res = await client.get(endpoint, formData);
        const data = res.data;

        // Get total count from first request only
        if (firstRequest) {
          totalCount = Number(res.headers["girder-total-count"]);
          firstRequest = false;
        }

        if (data.length === 0) {
          hasMore = false;
          break;
        }

        pages.push(data);
        downloaded += data.length;

        // Update progress
        if (progressId) {
          await progressStore.update({
            id: progressId,
            progress: downloaded,
            total: totalCount,
          });
        }

        // Stop if we got fewer items than requested (last page)
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          // Get the last ID for the next page
          const newCursor = data[data.length - 1]._id;

          // Check if cursor is stuck (backend not processing afterId correctly)
          if (newCursor === lastCursor && afterId) {
            cursorStuckCount++;

            if (cursorStuckCount >= MAX_CURSOR_STUCK) {
              // Clear pages and restart with offset pagination
              pages.length = 0;
              downloaded = 0;
              break;
            }
          } else {
            cursorStuckCount = 0; // Reset counter when cursor changes
          }

          afterId = newCursor;
          lastCursor = newCursor;
        }
      }

      if (requestCount >= MAX_REQUESTS) {
        logWarning(
          `[Cursor Pagination] Hit safety limit of ${MAX_REQUESTS} requests`,
        );
      }
    } catch (err) {
      logError(`Could not get all ${endpoint} pages:\n${err}`);
      throw err;
    }
  }

  // Check if cursor failed and fallback needed
  if (useCursor && pages.length === 0 && requestCount > 1) {
    logWarning(`[Cursor Pagination] Falling back to offset pagination`);
    useCursor = false;
    downloaded = 0;
  }

  // This will now execute if we fell back OR if we never tried cursor
  if (!useCursor) {
    // Offset-based pagination for endpoints without cursor support
    const fetchPage = async (offset: number, limit: number) => {
      const formData: AxiosRequestConfig = {
        ...baseFormData,
        params: {
          ...baseParams,
          offset,
          limit,
        },
      };
      try {
        const res = await client.get(endpoint, formData);
        totalCount = Number(res.headers["girder-total-count"]);
        pages.push(res.data);
        downloaded += res.data.length;
      } catch (err) {
        logError(`Could not get all ${endpoint} pages:\n${err}`);
        throw err;
      }
    };

    try {
      const firstPageSize = firstPage === undefined ? pageSize : firstPage;

      // Fetch first page
      await fetchPage(0, firstPageSize);
      if (progressId) {
        await progressStore.update({
          id: progressId,
          progress: downloaded,
          total: totalCount,
        });
      }

      // Fetch remaining pages in parallel
      const promises: Promise<any>[] = [];
      for (
        let offset = firstPageSize;
        offset < totalCount;
        offset += pageSize
      ) {
        promises.push(
          fetchPage(offset, pageSize).then(() => {
            if (progressId) {
              progressStore.update({
                id: progressId,
                progress: downloaded,
                total: totalCount,
              });
            }
          }),
        );
      }
      await Promise.all(promises);
    } catch {
      return [];
    }
  }

  // Complete progress tracking for both cursor and offset pagination
  if (progressId) {
    await progressStore.complete(progressId);
  }

  return pages;
}
