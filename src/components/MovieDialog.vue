<template>
  <v-dialog v-model="dialog" max-width="500px">
    <v-card>
      <v-card-title>Download Time-lapse Movie</v-card-title>

      <v-card-text>
        <v-container>
          <v-row>
            <v-col cols="6">
              <v-text-field
                label="Start Time"
                v-model="displayStartTime"
                type="number"
                :min="1"
                :max="displayMaxTimePoint"
                dense
                hide-details
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                label="End Time"
                v-model="displayEndTime"
                type="number"
                :min="1"
                :max="displayMaxTimePoint"
                dense
                hide-details
              />
            </v-col>
          </v-row>

          <v-row class="mt-4">
            <v-col cols="12">
              <v-text-field
                label="Frames per Second"
                v-model="fps"
                type="number"
                :min="1"
                :max="30"
                dense
                hide-details
              />
            </v-col>
          </v-row>

          <v-row class="mt-4">
            <v-col cols="12">
              <v-radio-group v-model="downloadFormat" row>
                <v-radio
                  label="Download zipped sequence of image files"
                  :value="MovieFormat.ZIP"
                ></v-radio>
                <v-radio
                  label="Download GIF"
                  :value="MovieFormat.GIF"
                ></v-radio>
                <v-radio
                  label="Download MP4"
                  :value="MovieFormat.MP4"
                  :disabled="!mp4Supported"
                ></v-radio>
                <v-radio
                  label="Download WebM"
                  :value="MovieFormat.WEBM"
                  :disabled="!webmSupported"
                ></v-radio>
              </v-radio-group>
            </v-col>
          </v-row>

          <v-row class="mt-4">
            <v-col cols="12">
              <v-checkbox
                v-model="shouldAddTimeStamp"
                label="Insert time stamp"
                dense
                hide-details
              />
            </v-col>
          </v-row>

          <template v-if="shouldAddTimeStamp">
            <v-row class="mt-4">
              <v-col cols="6">
                <v-text-field
                  label="Initial time"
                  v-model.number="initialTimeStampTime"
                  type="number"
                  dense
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  label="Time step"
                  v-model.number="timeStampStep"
                  type="number"
                  dense
                  hide-details
                />
              </v-col>
            </v-row>

            <v-row class="mt-4">
              <v-col cols="12">
                <v-select
                  label="Units"
                  v-model="timeStampUnits"
                  :items="timeUnits"
                  dense
                  hide-details
                />
              </v-col>
            </v-row>
          </template>

          <v-row v-if="warningText" class="mt-4">
            <v-col cols="12">
              <v-alert type="warning" dense text class="mb-0">
                {{ warningText }}
              </v-alert>
            </v-col>
          </v-row>
        </v-container>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn text @click="dialog = false"> Cancel </v-btn>
        <v-btn
          color="primary"
          @click="handleDownload"
          :disabled="!!warningText"
        >
          Download Movie
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { IDataset } from "@/store/model";
import { MovieFormat } from "./Snapshots.vue";

const props = defineProps<{
  value: boolean;
  currentTime: number;
  dataset: IDataset;
}>();

const emit = defineEmits<{
  (e: "input", value: boolean): void;
  (e: "download", payload: object): void;
}>();

const startTime = ref<number>(0);
const endTime = ref<number>(0);
const fps = ref<number>(10);
const downloadFormat = ref<MovieFormat>(MovieFormat.ZIP);
const shouldAddTimeStamp = ref<boolean>(false);
const initialTimeStampTime = ref<number>(0.0);
const timeStampStep = ref<number>(1.0);
const timeStampUnits = ref<string>("hours");
const timeUnits = ref<string[]>([
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
  "microseconds",
]);

const mp4Supported = computed<boolean>(() => {
  return (
    typeof MediaRecorder !== "undefined" &&
    (MediaRecorder.isTypeSupported("video/mp4") ||
      MediaRecorder.isTypeSupported(
        'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
      ))
  );
});

const webmSupported = computed<boolean>(() => {
  return (
    typeof MediaRecorder !== "undefined" &&
    (MediaRecorder.isTypeSupported("video/webm") ||
      MediaRecorder.isTypeSupported('video/webm; codecs="vp9,opus"') ||
      MediaRecorder.isTypeSupported('video/webm; codecs="vp8,opus"'))
  );
});

const dialog = computed({
  get: () => props.value,
  set: (value: boolean) => emit("input", value),
});

const maxTimePoint = computed<number>(() => {
  if (props.dataset) {
    return Math.max(...props.dataset.time);
  }
  return 0;
});

const displayMaxTimePoint = computed<number>(() => {
  return maxTimePoint.value + 1;
});

const displayStartTime = computed({
  get: () => startTime.value + 1,
  set: (value: number) => {
    startTime.value = value - 1;
  },
});

const displayEndTime = computed({
  get: () => endTime.value + 1,
  set: (value: number) => {
    endTime.value = value - 1;
  },
});

const warningText = computed<string>(() => {
  if (startTime.value > endTime.value) {
    return "Start time must be less than or equal to end time";
  }
  if (startTime.value < 0) {
    return "Start time must be greater than or equal to 1";
  }
  if (endTime.value > maxTimePoint.value) {
    return "End time must be less than or equal to the maximum time point";
  }
  if (fps.value < 1 || fps.value > 30) {
    return "Frames per second must be between 1 and 30";
  }
  if (endTime.value - startTime.value > 200) {
    return "Time range cannot exceed 200 frames";
  }
  return "";
});

watch(
  () => props.value,
  (newValue: boolean) => {
    if (newValue) {
      startTime.value = props.currentTime;
      endTime.value = maxTimePoint.value;
    }
  },
);

function handleDownload() {
  if (warningText.value) {
    return;
  }

  emit("download", {
    startTime: startTime.value,
    endTime: endTime.value,
    fps: fps.value,
    format: downloadFormat.value,
    shouldAddTimeStamp: shouldAddTimeStamp.value,
    initialTimeStampTime: initialTimeStampTime.value,
    timeStampStep: timeStampStep.value,
    timeStampUnits: timeStampUnits.value,
  });
  dialog.value = false;
}

defineExpose({
  dialog,
  startTime,
  endTime,
  fps,
  downloadFormat,
  warningText,
  maxTimePoint,
  displayMaxTimePoint,
  displayStartTime,
  displayEndTime,
  mp4Supported,
  webmSupported,
  handleDownload,
  shouldAddTimeStamp,
  initialTimeStampTime,
  timeStampStep,
  timeStampUnits,
  timeUnits,
});
</script>
