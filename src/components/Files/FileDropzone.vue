<template>
  <div
    :class="dropzoneClass"
    class="dropzone-wrapper"
    @dragenter="dropzoneClass = 'animate'"
    @dragleave="dropzoneClass = null"
    @drop="dropzoneClass = null"
  >
    <div class="dropzone-overlay"></div>
    <v-row
      no-gutters
      class="flex-column align-center justify-center fill-height dropzone-message"
    >
      <slot name="default">
        <v-icon size="50px"> $vuetify.icons.fileUpload </v-icon>
        <div class="title mt-3">
          <template v-if="multiple">
            Drag files here or click to select them
          </template>
          <template v-else> Drag a file here or click to select one </template>
        </div>
      </slot>
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

const props = withDefaults(
  defineProps<{
    value?: File[];
    message?: string;
    multiple?: boolean;
    accept?: string;
  }>(),
  {
    value: () => [],
    message: "",
    multiple: true,
    accept: undefined,
  },
);

const emit = defineEmits<{
  (e: "input", files: File[]): void;
}>();

const files = computed({
  get: () => props.value,
  set: (val: File[]) => emit("input", val),
});

const dropzoneClass = ref<string | null>(null);

function onChange(event: Event) {
  const inputElem = event.target as HTMLInputElement | null;
  const fileList = inputElem?.files || [];
  files.value = [...fileList];
}

defineExpose({ dropzoneClass });
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

.theme--dark .dropzone-overlay {
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
