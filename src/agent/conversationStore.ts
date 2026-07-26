import type { IAgentPanelItem } from "@/store/aiPanel";
import type { IAgentWireMessage } from "@/store/AgentAPI";
import type { IAgentPlot } from "./plotRegistry";
import { logError } from "@/utils/log";

// Browser-local persistence for the AI-panel conversation. A single stored
// record (one slot), tagged with the owning user id — the aiPanel store
// restores it for the same user and wipes it for a different one. No Vuex
// reactivity: IndexedDB's structured clone can't handle Vue proxies.
// Durable server-side storage is deliberately out of scope (see the spec).

const DB_NAME = "AgentConversationDB";
const STORE_NAME = "conversation";
const RECORD_KEY = "current";

// Cache the single IDBDatabase connection to avoid leaking new connections
// on each conversation save/load.
let dbPromise: Promise<IDBDatabase> | null = null;

export interface IStoredAgentConversation {
  userId: string;
  items: IAgentPanelItem[];
  wireMessages: IAgentWireMessage[];
  plots?: IAgentPlot[];
  updatedAt: number;
}

export const MAX_STORED_PLOTS = 12;
export const MAX_STORED_PLOT_CHARS = 3_000_000;

// Plots worth persisting: those referenced by a current transcript item,
// newest-first capped at MAX_STORED_PLOTS, skipping any single plot whose
// serialized size exceeds MAX_STORED_PLOT_CHARS. Returned in original
// (insertion) order so restorePlots keeps ids monotonic.
export function selectPlotsForStorage(
  items: IAgentPanelItem[],
  plots: IAgentPlot[],
): IAgentPlot[] {
  const referencedIds = new Set(
    items
      .filter((item) => item.kind === "plot" && item.plotId)
      .map((item) => item.plotId),
  );
  return plots
    .filter(
      (plot) =>
        referencedIds.has(plot.id) &&
        JSON.stringify(plot).length <= MAX_STORED_PLOT_CHARS,
    )
    .slice(-MAX_STORED_PLOTS);
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadStoredConversation(): Promise<IStoredAgentConversation | null> {
  try {
    const db = await openDatabase();
    const store = db
      .transaction([STORE_NAME], "readonly")
      .objectStore(STORE_NAME);
    const result = await requestToPromise(store.get(RECORD_KEY));
    return (result as IStoredAgentConversation) ?? null;
  } catch (error) {
    logError("Failed to load stored agent conversation:", error);
    return null;
  }
}

export async function saveStoredConversation(
  record: IStoredAgentConversation,
): Promise<void> {
  try {
    const db = await openDatabase();
    const store = db
      .transaction([STORE_NAME], "readwrite")
      .objectStore(STORE_NAME);
    // Strip Vue reactive proxies — structured clone rejects them.
    const plain = JSON.parse(JSON.stringify(record));
    await requestToPromise(store.put(plain, RECORD_KEY));
  } catch (error) {
    logError("Failed to save agent conversation:", error);
  }
}

export async function clearStoredConversation(): Promise<void> {
  try {
    const db = await openDatabase();
    const store = db
      .transaction([STORE_NAME], "readwrite")
      .objectStore(STORE_NAME);
    await requestToPromise(store.delete(RECORD_KEY));
  } catch (error) {
    logError("Failed to clear agent conversation:", error);
  }
}
