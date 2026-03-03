import {
  VuexModule,
  Module,
  Mutation,
  Action,
  getModule,
} from "vuex-module-decorators";
import { toRaw } from "vue";
import { logError } from "@/utils/log";
import store from "./root";
import { IChatMessage } from "./model";
import main from "./index";

// Stored outside Vuex state to avoid Vue 3 reactive proxy wrapping.
// IDBDatabase is a native browser object whose methods break when proxied.
let database: IDBDatabase | null = null;

// Returns a promise and its associated "resolve" and "reject" functions
function getPromiseResolveReject<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ChatHistoryDB", 1);

    request.onerror = reject;

    request.onsuccess = () => {
      const database = request.result;
      resolve(database);
    };

    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("messages", {
        keyPath: "id",
        autoIncrement: true,
      });
    };
  });
}

@Module({ dynamic: true, store, name: "chat" })
export class Chat extends VuexModule {
  messages: IChatMessage[] = [];
  initialized: boolean = false;

  @Mutation
  private setInitialized(value: boolean) {
    this.initialized = value;
  }

  @Mutation
  private addMessageImpl(message: IChatMessage) {
    this.messages.push(message);
  }

  @Mutation
  private setMessages(messages: IChatMessage[]) {
    this.messages = messages;
  }

  @Action
  async initializeChatDatabase() {
    if (this.initialized) {
      return;
    }
    try {
      database = await openDatabase();
    } catch (e) {
      logError(`Failed to open chat database: ${e}.`);
      return;
    }

    const transaction = database.transaction(["messages"], "readonly");
    const store = transaction.objectStore("messages");
    const getRequest = store.getAll();

    const { promise, resolve, reject } = getPromiseResolveReject<void>();

    getRequest.onerror = () => {
      reject("Error loading messages");
    };

    getRequest.onsuccess = () => {
      this.setMessages(getRequest.result);
      this.setInitialized(true);
      resolve();
    };

    await promise;
  }

  // Use send message instead of addMessage
  // This action adds a message to the database but doesn't ask for an answer
  @Action
  private async addMessage(message: IChatMessage) {
    if (!database) {
      logError("Can't add a message when database is not open.");
      return;
    }
    const transaction = database.transaction(["messages"], "readwrite");
    const store = transaction.objectStore("messages");
    // Strip Vue reactive proxies — IndexedDB's structured clone can't handle them
    const plainMessage = JSON.parse(JSON.stringify(toRaw(message)));
    const addRequest = store.add(plainMessage);

    const { promise, resolve, reject } = getPromiseResolveReject<void>();
    addRequest.onerror = () => {
      reject("Error saving message in database.");
    };
    addRequest.onsuccess = () => {
      this.addMessageImpl(message);
      resolve();
    };
    await promise;
  }

  // Add a message to the database and get the answer
  @Action
  async sendMessage(message: IChatMessage) {
    await this.addMessage(message);
    try {
      const botResponse = await main.chatAPI.getChatBotAnswerToConversation(
        this.messages,
      );

      if (botResponse === null) {
        throw "Received null response from API";
      }
      await this.addMessage(botResponse);
    } catch (error: any) {
      logError("Error sending message:", error);
      const errorMessage: IChatMessage = {
        type: "error",
        content: `Error sending message: ${error.message}. Please check console for details.`,
      };
      await this.addMessage(errorMessage);
    }
  }

  @Action
  async clearAll() {
    if (!database) {
      logError("Can't clear messages when database is not open.");
      return;
    }

    const transaction = database.transaction(["messages"], "readwrite");
    const store = transaction.objectStore("messages");
    const clearRequest = store.clear();

    const { promise, resolve, reject } = getPromiseResolveReject<void>();
    clearRequest.onerror = () => {
      reject("Error clearing database");
    };
    clearRequest.onsuccess = () => {
      this.setMessages([]);
      resolve();
    };
    await promise;
  }
}

export default getModule(Chat);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
