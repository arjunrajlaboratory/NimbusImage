<template>
  <div ref="rootEl">
    <v-card class="chat-component">
      <div class="chat-header">
        <span class="chat-title">Nimbus chat</span>
        <div class="chat-header-actions">
          <v-btn
            icon
            variant="text"
            size="small"
            @click="refreshChat"
            :loading="isRefreshing"
          >
            <v-icon size="small">mdi-refresh</v-icon>
          </v-btn>
          <v-btn icon variant="text" size="small" @click="emit('close')">
            <v-icon size="small">mdi-close</v-icon>
          </v-btn>
        </div>
      </div>
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
              <img
                :src="image.data"
                alt="Current image"
                class="current-image"
              />
              <v-btn
                icon
                size="small"
                class="remove-image"
                @click="removeImage(index)"
              >
                <v-icon>mdi-close</v-icon>
              </v-btn>
            </div>
          </div>
          <div class="bottom-inputs">
            <v-textarea
              v-model="textInput"
              class="chat-input"
              placeholder="Type a message..."
              rows="2"
              no-resize
              density="compact"
              variant="outlined"
              hide-details
              @keyup.enter="!$event.shiftKey ? sendMessage() : undefined"
              @paste="handlePaste"
            />
            <v-btn icon variant="text" size="small" @click="fileInput?.click()">
              <v-icon size="small">mdi-image</v-icon>
            </v-btn>
            <v-btn
              icon
              variant="flat"
              size="small"
              color="primary"
              @click="sendMessage"
            >
              <v-icon size="small">mdi-send</v-icon>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { logError } from "@/utils/log";
import store from "@/store";
import chatStore from "@/store/chat";
import { IChatImage, IChatMessage, IGeoJSMap } from "@/store/model";
import { marked } from "marked";
import html2canvas from "html2canvas";

const emit = defineEmits<{
  (e: "close"): void;
}>();

const chatMessages = ref<HTMLElement>();
const fileInput = ref<HTMLInputElement>();

const textInput = ref("");
const imagesInput = ref<IChatImage[]>([]);
const isWaiting = ref(false);
const isRefreshing = ref(false);

const rootEl = ref<HTMLElement>();

const messages = computed(() => chatStore.messages);

const geoJSMaps = computed(() => store.maps.map((map) => map.map));

const firstMap = computed<IGeoJSMap | undefined>(() =>
  geoJSMaps.value.length ? geoJSMaps.value[0] : undefined,
);

const visibleImagesInput = computed(() =>
  filterVisibleImages(imagesInput.value),
);

function clearInputs() {
  textInput.value = "";
  imagesInput.value = [];
}

async function sendMessage(visible: boolean = true, customInput?: string) {
  const trimmedInput = customInput || textInput.value.trim();
  if (isWaiting.value || !trimmedInput) {
    return;
  }

  const interfaceScreenshot = await captureInterfaceScreenshot();
  if (interfaceScreenshot) {
    imagesInput.value.unshift(interfaceScreenshot);
  }

  const viewportScreenshot = await captureViewportScreenshot();
  if (viewportScreenshot) {
    imagesInput.value.unshift(viewportScreenshot);
  }

  const userMessage: IChatMessage = {
    type: "user",
    content: trimmedInput,
    images: [...imagesInput.value],
    visible: visible,
  };

  clearInputs();
  try {
    isWaiting.value = true;
    await chatStore.sendMessage(userMessage);
  } finally {
    isWaiting.value = false;
  }
}

function addImageFile(file: File) {
  if (imagesInput.value.length >= 4) {
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    if (imagesInput.value.length >= 4) {
      return;
    }
    const result = e.target?.result as string;
    imagesInput.value.push({ data: result, type: file.type });
  };
  reader.readAsDataURL(file);
}

async function handleFileUpload(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files || !files.length) {
    return;
  }

  // Up to 4 images can be uploaded
  for (let i = 0; i < files.length; i++) {
    try {
      const file = files[i];
      addImageFile(file);
    } catch (error) {
      logError("Error processing file:", error);
    }
  }
  fileInput.value!.value = "";
}

async function handlePaste(event: ClipboardEvent) {
  event.preventDefault();
  const items = event.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf("image") !== -1) {
      const file = items[i].getAsFile();
      if (file) {
        addImageFile(file);
      }
    } else if (items[i].type === "text/plain") {
      items[i].getAsString((text) => {
        textInput.value += text;
      });
    }
  }
}

function removeImage(index: number) {
  imagesInput.value.splice(index, 1);
}

async function refreshChat() {
  isRefreshing.value = true;
  clearInputs();
  await chatStore.clearAll();
  const firstMessage =
    "This is the first hidden user message. You will get two screenshots, one of the interface and one of the image itself in the viewport. Start by saying 'Hello, I'm here to help you with NimbusImage! Looks like you are looking at' and then quickly summarize what you see in a couple sentences. Then offer to help by asking what the user would like to do.";
  await sendMessage(false, firstMessage);
  isRefreshing.value = false;
}

async function captureInterfaceScreenshot(): Promise<IChatImage | null> {
  try {
    const el = rootEl.value!;
    const canvas = await html2canvas(document.body, {
      ignoreElements: (element) => {
        return element === el || el.contains(element);
      },
    });
    const imageData = canvas.toDataURL("image/png");
    return { data: imageData, type: "image/png", visible: false };
  } catch (error) {
    logError("Error capturing screenshot:", error);
    return null;
  }
}

async function captureViewportScreenshot(): Promise<IChatImage | null> {
  const map = firstMap.value;
  if (!map) {
    return null;
  }
  const layers = map
    .layers()
    .filter((layer: any) => layer.node().css("visibility") !== "hidden");
  const image = await map.screenshot(layers);
  return { data: image, type: "image/png", visible: false };
}

function filterVisibleImages(images: IChatImage[]) {
  return images.filter((image) => image.visible !== false);
}

function filterVisibleMessages(messages: IChatMessage[]) {
  return messages.filter((message) => message.visible !== false).reverse();
}

onMounted(() => {
  if (messages.value.length === 0) {
    refreshChat();
  }
});

defineExpose({
  textInput,
  imagesInput,
  isWaiting,
  isRefreshing,
  messages,
  firstMap,
  visibleImagesInput,
  sendMessage,
  addImageFile,
  handleFileUpload,
  removeImage,
  refreshChat,
  captureViewportScreenshot,
  filterVisibleImages,
  filterVisibleMessages,
});
</script>

<style scoped>
/* === Card container === */
.chat-component {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 520px;
  height: 680px;
  max-height: 680px;
  z-index: 1000;
  background-color: rgba(0, 0, 0, 0.8) !important;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px !important;
}

/* === Header === */
.chat-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.chat-title {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.9;
}

.chat-header-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

/* === Message area === */
:deep(.v-card-text) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px !important;
}

.chat-messages {
  display: flex;
  flex-direction: column-reverse;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  gap: 8px;
  padding: 4px;
}

/* === Message bubbles === */
.user {
  align-self: flex-end;
  color: #ffffff;
  background-color: rgba(33, 150, 243, 0.25);
  border: 1px solid rgba(33, 150, 243, 0.3);
  padding: 8px 12px;
  border-radius: 12px 12px 2px 12px;
  max-width: 80%;
  width: fit-content;
  font-size: 0.85rem;
  line-height: 1.4;
}

.assistant {
  align-self: flex-start;
  color: rgba(255, 255, 255, 0.92);
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 10px 14px;
  border-radius: 12px 12px 12px 2px;
  max-width: 90%;
  width: fit-content;
  font-size: 0.85rem;
  line-height: 1.5;
}

/* === Markdown (v-html needs :deep) === */
.assistant :deep(h1),
.assistant :deep(h2),
.assistant :deep(h3),
.assistant :deep(h4) {
  font-size: 0.9rem;
  font-weight: 700;
  margin: 0.6em 0 0.2em;
}

.assistant :deep(p) {
  margin: 0.25em 0;
}

.assistant :deep(ul),
.assistant :deep(ol) {
  padding-left: 1.4em;
  margin: 0.25em 0;
}

.assistant :deep(li) {
  margin: 0.1em 0;
}

.assistant :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.82rem;
}

.assistant :deep(pre) {
  background: rgba(0, 0, 0, 0.3);
  padding: 0.5em;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.4em 0;
}

.assistant :deep(pre code) {
  background: none;
  padding: 0;
}

/* === System / error messages === */
.system,
.error {
  text-align: center;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.7);
  background-color: rgba(255, 80, 80, 0.15);
  border: 1px solid rgba(255, 80, 80, 0.2);
  border-radius: 8px;
  padding: 6px 12px;
  margin: 2px 0;
}

/* === Image attachments in messages === */
.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
  gap: 4px;
  margin-bottom: 6px;
}

.message-image {
  max-width: 100%;
  max-height: 120px;
  object-fit: contain;
  border-radius: 6px;
}

/* === Input area === */
:deep(.v-card-actions) {
  flex-direction: column;
  align-items: stretch;
  flex-shrink: 0;
  padding: 0 !important;
}

.current-images {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px;
}

.current-image-container {
  position: relative;
}

.current-image {
  max-width: 60px;
  max-height: 60px;
  object-fit: contain;
  border-radius: 4px;
}

.remove-image {
  position: absolute;
  top: -4px;
  right: -4px;
  background: rgba(255, 60, 60, 0.8) !important;
  color: white;
}

.bottom-inputs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.chat-input {
  flex: 1;
}
</style>
