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
  const useCursor = CURSOR_SUPPORTED_ENDPOINTS.includes(endpoint);

  // Only capture progress for these endpoints
  const PROGRESS_ENDPOINTS = [
    "upenn_annotation",
    "annotation_connection",
    "annotation_property_values",
  ];

  const progressId = PROGRESS_ENDPOINTS.includes(endpoint)
    ? await progressStore.create({ endpoint })
    : null;

  const baseParams = {
    limit: 100000,
    sort: "_id",
    ...baseFormData?.params,
  };
  const pageSize = baseParams.limit;

  let result: {
    pages: any[];
    totalCount: number;
    downloaded: number;
    success?: boolean;
  };

  if (useCursor && baseParams.sort === "_id") {
    // Try cursor pagination first
    // Ensure that the sort is _id, otherwise the cursor pagination will not work.
    result = await fetchPagesUsingCursor(
      client,
      endpoint,
      baseFormData,
      baseParams,
      pageSize,
      progressId,
    );

    // If cursor pagination failed, fall back to offset
    if (!result.success) {
      logWarning(
        `[Cursor Pagination] Falling back to offset pagination for endpoint: ${endpoint}`,
      );
      result = await fetchPagesUsingOffset(
        client,
        endpoint,
        baseFormData,
        baseParams,
        pageSize,
        firstPage,
        progressId,
      );
    }
  } else {
    // Use offset pagination directly
    result = await fetchPagesUsingOffset(
      client,
      endpoint,
      baseFormData,
      baseParams,
      pageSize,
      firstPage,
      progressId,
    );
  }

  // Complete progress tracking
  if (progressId) {
    await progressStore.complete(progressId);
  }

  return result.pages;
}

async function fetchPagesUsingCursor(
  client: RestClientInstance,
  endpoint: string,
  baseFormData: AxiosRequestConfig | undefined,
  baseParams: any,
  pageSize: number,
  progressId: string | null,
): Promise<{
  pages: any[];
  totalCount: number;
  downloaded: number;
  success: boolean;
}> {
  const pages: any[] = [];
  let totalCount = -1;
  let downloaded = 0;
  let afterId: string | null = null;
  let hasMore = true;
  let firstRequest = true;
  let lastCursor: string | null = null;
  let cursorStuckCount = 0;
  let requestCount = 0;
  const MAX_REQUESTS = 100; // Safety limit to prevent infinite loops
  const MAX_CURSOR_STUCK = 1; // If cursor doesn't change, fall back to offset

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

    return {
      pages,
      totalCount,
      downloaded,
      success: true, // Cursor pagination completed successfully (even with empty results)
    };
  } catch (err) {
    logError(`Could not get all ${endpoint} pages:\n${err}`);
    throw err;
  }
}

async function fetchPagesUsingOffset(
  client: RestClientInstance,
  endpoint: string,
  baseFormData: AxiosRequestConfig | undefined,
  baseParams: any,
  pageSize: number,
  firstPage: number | undefined,
  progressId: string | null,
): Promise<{ pages: any[]; totalCount: number; downloaded: number }> {
  const pages: any[] = [];
  let totalCount = -1;
  let downloaded = 0;

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
    for (let offset = firstPageSize; offset < totalCount; offset += pageSize) {
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

    return { pages, totalCount, downloaded };
  } catch {
    return { pages: [], totalCount: 0, downloaded: 0 };
  }
}
