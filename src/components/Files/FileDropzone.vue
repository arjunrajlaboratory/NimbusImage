<template>
  <div
    :class="dropzoneClass"
    class="dropzone-wrapper"
    @dragenter.prevent="dropzoneClass = 'animate'"
    @dragover.prevent
    @dragleave="dropzoneClass = null"
    @drop.prevent="onDrop"
  >
    <div class="dropzone-overlay"></div>
    <v-row
      no-gutters
      class="flex-column align-center justify-center fill-height dropzone-message"
    >
      <slot name="default">
        <v-icon size="50px">mdi-file-upload</v-icon>
        <div class="text-body-1 font-weight-medium mt-3">
          <template v-if="multiple">
            Drag files or a folder here or click to select them
          </template>
          <template v-else> Drag a file here or click to select one </template>
        </div>
      </slot>
      <div v-if="multiple && directory" class="mt-2 folder-select-action">
        <v-btn
          variant="text"
          size="small"
          color="primary"
          @click.stop="selectFolder"
        >
          <v-icon start>mdi-folder-upload</v-icon>
          Select a folder instead
        </v-btn>
      </div>
      <slot name="afterMessage"></slot>
    </v-row>
    <input
      :multiple="multiple"
      :accept="accept"
      class="file-input"
      type="file"
      @change="onChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { getFilesFromDrop, selectFilesFromFolder } from "@/utils/fileUpload";

const props = withDefaults(
  defineProps<{
    modelValue?: File[];
    message?: string;
    multiple?: boolean;
    accept?: string;
    directory?: boolean;
  }>(),
  {
    modelValue: () => [],
    message: "",
    multiple: true,
    accept: undefined,
    directory: true,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", files: File[]): void;
}>();

const files = computed({
  get: () => props.modelValue,
  set: (val: File[]) => emit("update:modelValue", val),
});

const dropzoneClass = ref<string | null>(null);

function onChange(event: Event) {
  const inputElem = event.target as HTMLInputElement | null;
  const fileList = inputElem?.files || [];
  files.value = [...fileList];
}

async function onDrop(event: DragEvent) {
  dropzoneClass.value = null;
  const dropped = await getFilesFromDrop(event);
  files.value = props.multiple ? dropped : dropped.slice(0, 1);
}

async function selectFolder() {
  const folderFiles = await selectFilesFromFolder();
  if (folderFiles.length > 0) {
    files.value = folderFiles;
  }
}

defineExpose({ dropzoneClass, onDrop, selectFolder });
</script>

<style lang="scss" scoped>
$img: linear-gradient(
  -45deg,
  rgba(160, 160, 160, 0.12) 25%,
  transparent 25%,
  transparent 50%,
  rgba(160, 160, 160, 0.12) 50%,
  rgba(160, 160, 160, 0.12) 75%,
  transparent 75%,
  transparent
);

.dropzone-wrapper {
  position: relative;
  cursor: pointer;
  min-height: 100px;
  height: 100%;
  background-color: var(--v-dropzone-base);
  background-repeat: repeat;
  background-size: 30px 30px;

  &:hover {
    background-image: $img;
  }

  &.animate {
    animation: stripes 2s linear infinite;
    background-image: $img;
  }

  .dropzone-message {
    position: absolute;
    width: 100%;
  }

  .file-input {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    height: 100%;
    width: 100%;
    opacity: 0;
    z-index: 1;
    cursor: pointer;
  }

  // Raise the folder button above the invisible full-cover .file-input
  // (z-index: 1) so clicks reach the button instead of opening the file
  // dialog. It is a flex item of the message row, so z-index applies.
  .folder-select-action {
    z-index: 2;
  }
}

@keyframes stripes {
  from {
    background-position: 0 0;
  }

  to {
    background-position: 30px 60px;
  }
}

$overlayDark: linear-gradient(
  var(--v-dropzone-lighten3),
  var(--v-dropzone-lighten3)
);

$overlayLight: linear-gradient(
  var(--v-dropzone-darken4),
  var(--v-dropzone-darken4)
);

.dropzone-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border: 7px solid transparent;
  background:
    $overlayLight top left,
    $overlayLight top left,
    $overlayLight bottom left,
    $overlayLight bottom left,
    $overlayLight top right,
    $overlayLight top right,
    $overlayLight bottom right,
    $overlayLight bottom right;
  background-size:
    5px 24px,
    24px 5px;
  background-repeat: no-repeat;
}

.v-theme--dark .dropzone-overlay {
  background:
    $overlayDark top left,
    $overlayDark top left,
    $overlayDark bottom left,
    $overlayDark bottom left,
    $overlayDark top right,
    $overlayDark top right,
    $overlayDark bottom right,
    $overlayDark bottom right;
  background-size:
    5px 24px,
    24px 5px;
  background-repeat: no-repeat;
}
</style>
