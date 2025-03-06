<template>
  <v-card class="chat-component">
    <v-card-title>
      Nimbus chat
      <v-spacer></v-spacer>
      <v-btn icon @click="refreshChat" :loading="isRefreshing">
        <v-icon>mdi-refresh</v-icon>
      </v-btn>
      <v-btn icon @click="$emit('close')">
        <v-icon>mdi-close</v-icon>
      </v-btn>
    </v-card-title>
    <v-card-text>
      <div ref="chatMessages" class="chat-messages">
        <div
          v-for="(message, index) in filterVisibleMessages(messages)"
          :key="index"
          :class="message.type"
        >
          <div
            v-if="message.images && message.images.length > 0"
            class="image-grid"
          >
            <img
              v-for="(image, imgIndex) in filterVisibleImages(message.images)"
              :key="imgIndex"
              :src="image.data"
              alt="User uploaded image"
              class="message-image"
            />
          </div>
          <div
            v-if="message.type === 'assistant'"
            v-html="marked(message.content)"
          ></div>
          <div v-else>{{ message.content }}</div>
        </div>
      </div>
    </v-card-text>
    <v-card-actions>
      <template v-if="isWaiting">
        <v-progress-circular
          indeterminate
          color="primary"
        ></v-progress-circular>
      </template>
      <template v-else>
        <div v-if="visibleImagesInput.length > 0" class="current-images">
          <div
            v-for="(image, index) in visibleImagesInput"
            :key="index"
            class="current-image-container"
          >
            <img :src="image.data" alt="Current image" class="current-image" />
            <v-btn icon small class="remove-image" @click="removeImage(index)">
              <v-icon>mdi-close</v-icon>
            </v-btn>
          </div>
        </div>
        <div class="bottom-inputs">
          <v-textarea
            v-model="textInput"
            class="mx-2"
            label="Type a message"
            rows="2"
            no-resize
            @keyup.enter="!$event.shiftKey ? sendMessage() : undefined"
            @paste="handlePaste"
          />
          <v-btn @click="sendMessage" outlined>Send</v-btn>
          <v-btn icon @click="$refs.fileInput.click()">
            <v-icon>mdi-image</v-icon>
          </v-btn>
          <input
            ref="fileInput"
            type="file"
            @change="handleFileUpload"
            accept="image/*"
            multiple
            style="display: none"
          />
        </div>
      </template>
    </v-card-actions>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import { logError } from "@/utils/log";
import store from "@/store";
import chatStore from "@/store/chat";
import {
  IChatImage,
  IChatMessage,
  IGeoJSAnnotationLayer,
  IGeoJSMap,
} from "@/store/model";
import { marked } from "marked";
import html2canvas from "html2canvas";

@Component
export default class ChatComponent extends Vue {
  readonly store = store;

  $el!: HTMLElement;
  textInput = "";
  imagesInput: IChatImage[] = [];
  isWaiting = false;
  isRefreshing = false;

  bboxLayer: IGeoJSAnnotationLayer | null = null;

  marked = marked;

  $refs!: {
    chatMessages: HTMLElement;
    fileInput: HTMLInputElement;
  };

  get messages() {
    return chatStore.messages;
  }

  clearInputs() {
    this.textInput = "";
    this.imagesInput = [];
  }

  get geoJSMaps() {
    return this.store.maps.map((map) => map.map);
  }

  get firstMap(): IGeoJSMap | undefined {
    return this.geoJSMaps.length ? this.geoJSMaps[0] : undefined;
  }

  async sendMessage(visible: boolean = true, customInput?: string) {
    const trimmedInput = customInput || this.textInput.trim();
    if (this.isWaiting || !trimmedInput) {
      return;
    }

    const interfaceScreenshot = await this.captureInterfaceScreenshot();
    if (interfaceScreenshot) {
      this.imagesInput.unshift(interfaceScreenshot);
    }

    const viewportScreenshot = await this.captureViewportScreenshot();
    if (viewportScreenshot) {
      this.imagesInput.unshift(viewportScreenshot);
    }

    const userMessage: IChatMessage = {
      type: "user",
      content: trimmedInput,
      images: [...this.imagesInput],
      visible: visible,
    };

    this.clearInputs();
    try {
      this.isWaiting = true;
      await chatStore.sendMessage(userMessage);
    } finally {
      this.isWaiting = false;
    }
  }

  addImageFile(file: File) {
    if (this.imagesInput.length >= 4) {
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      if (this.imagesInput.length >= 4) {
        return;
      }
      const result = e.target?.result as string;
      this.imagesInput.push({ data: result, type: file.type });
    };
    reader.readAsDataURL(file);
  }

  async handleFileUpload(event: Event) {
    const files = (event.target as HTMLInputElement).files;
    if (!files || !files.length) {
      return;
    }

    // Up to 4 images can be uploaded
    for (let i = 0; i < files.length; i++) {
      try {
        const file = files[i];
        this.addImageFile(file);
      } catch (error) {
        logError("Error processing file:", error);
      }
    }
    this.$refs.fileInput.value = "";
  }

  async handlePaste(event: ClipboardEvent) {
    event.preventDefault();
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          this.addImageFile(file);
        }
      } else if (items[i].type === "text/plain") {
        items[i].getAsString((text) => {
          this.textInput += text;
        });
      }
    }
  }

  removeImage(index: number) {
    this.imagesInput.splice(index, 1);
  }

  async refreshChat() {
    this.isRefreshing = true;
    this.clearInputs();
    await chatStore.clearAll();
    const firstMessage =
      "This is the first hidden user message. You will get two screenshots, one of the interface and one of the image itself in the viewport. Start by saying 'Hello, I'm here to help you with NimbusImage! Looks like you are looking at' and then quickly summarize what you see in a couple sentences. Then offer to help by asking what the user would like to do.";
    await this.sendMessage(false, firstMessage);
    this.isRefreshing = false;
  }

  mounted() {
    if (this.messages.length === 0) {
      this.refreshChat();
    }
  }

  async captureInterfaceScreenshot(): Promise<IChatImage | null> {
    try {
      const canvas = await html2canvas(document.body, {
        ignoreElements: (element) => {
          return element === this.$el || this.$el.contains(element);
        },
      });
      const imageData = canvas.toDataURL("image/png");
      return { data: imageData, type: "image/png", visible: false };
    } catch (error) {
      logError("Error capturing screenshot:", error);
      return null;
    }
  }

  async captureViewportScreenshot(): Promise<IChatImage | null> {
    const map = this.firstMap;
    if (!map) {
      return null;
    }
    const layers = map
      .layers()
      .filter((layer: any) => layer.node().css("visibility") !== "hidden");
    const image = await map.screenshot(layers);
    return { data: image, type: "image/png", visible: false };
  }

  filterVisibleImages(images: IChatImage[]) {
    return images.filter((image) => image.visible !== false);
  }

  get visibleImagesInput() {
    return this.filterVisibleImages(this.imagesInput);
  }

  filterVisibleMessages(messages: IChatMessage[]) {
    return messages.filter((message) => message.visible !== false).reverse();
  }

  get visibleMessages() {
    return this.filterVisibleMessages(this.messages);
  }
}
</script>

<style scoped>
.chat-component {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 600px;
  height: 700px;
  max-height: 700px;
  z-index: 1000;
  background-color: rgba(0, 0, 0, 0.8) !important;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.v-card__text {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  overflow-y: hidden;
}

.v-card__actions {
  flex-direction: column;
  align-items: start;
}

.chat-messages {
  display: flex;
  flex-direction: column-reverse;
  overflow-y: auto;
}

.user {
  align-self: flex-end;
  color: #2196f3;
  background-color: rgba(0, 0, 0, 0.5);
  padding: 3px 10px;
  margin: 2px 0px 2px 20px;
  width: fit-content;
}

.assistant {
  align-self: flex-start;
  color: #ffffff;
  background-color: rgba(0, 0, 0, 0.5);
  padding: 3px 10px;
  margin: 2px 20px 2px 0px;
  width: fit-content;
}

.system,
.error {
  text-align: center;
  color: black;
  background-color: aliceblue;
  margin: 5px 0;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 5px;
  margin-bottom: 5px;
}

.message-image {
  max-width: 100%;
  max-height: 150px;
  object-fit: contain;
}

.current-images {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 5px;
}

.current-image-container {
  position: relative;
}

.current-image {
  max-width: 80px;
  max-height: 80px;
  object-fit: contain;
}

.bottom-inputs {
  width: 100%;
  display: flex;
  align-items: center;
  background-color: rgba(0, 0, 0, 0.7);
}

.remove-image {
  position: absolute;
  top: 0;
  right: 0;
  background: rgba(255, 0, 0, 0.7);
  color: white;
}

.refresh-button {
  margin-top: 10px;
}
</style>
