import type { IAgentPanelItem } from "@/store/aiPanel";
import type { IAgentWireMessage } from "@/store/AgentAPI";
import { logError } from "@/utils/log";

// Browser-local persistence for the AI-panel conversation. A single stored
// record (one slot), tagged with the owning user id — the aiPanel store
// restores it for the same user and wipes it for a different one. No Vuex
// reactivity: IndexedDB's structured clone can't handle Vue proxies.
// Durable server-side storage is deliberately out of scope (see the spec).

const DB_NAME = "AgentConversationDB";
const STORE_NAME = "conversation";
const RECORD_KEY = "current";

export interface IStoredAgentConversation {
  userId: string;
  items: IAgentPanelItem[];
  wireMessages: IAgentWireMessage[];
  updatedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
  });
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
