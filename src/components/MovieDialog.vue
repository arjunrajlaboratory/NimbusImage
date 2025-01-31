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
                  label="Download movie"
                  :value="MovieFormat.WEBM"
                ></v-radio>
              </v-radio-group>
            </v-col>
          </v-row>

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

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import { IDataset } from "@/store/model";
import { MovieFormat } from "./Snapshots.vue";

@Component
export default class MovieDialog extends Vue {
  @Prop({ required: true })
  value!: boolean;

  @Prop({ required: true })
  currentTime!: number;

  @Prop({ required: true })
  dataset!: IDataset;

  MovieFormat = MovieFormat; // Make enum available in template

  startTime: number = 0;
  endTime: number = 0;
  fps: number = 10;
  downloadFormat: MovieFormat = MovieFormat.ZIP;

  @Watch("value")
  onDialogOpen(newValue: boolean) {
    if (newValue) {
      this.startTime = this.currentTime;
      this.endTime = this.maxTimePoint;
    }
  }

  get dialog() {
    return this.value;
  }

  set dialog(value: boolean) {
    this.$emit("input", value);
  }

  get maxTimePoint(): number {
    if (this.dataset) {
      return Math.max(...this.dataset.time);
    }
    return 0;
  }

  get displayMaxTimePoint(): number {
    return this.maxTimePoint + 1;
  }

  get displayStartTime(): number {
    return this.startTime + 1;
  }

  set displayStartTime(value: number) {
    this.startTime = value - 1;
  }

  get displayEndTime(): number {
    return this.endTime + 1;
  }

  set displayEndTime(value: number) {
    this.endTime = value - 1;
  }

  get warningText(): string {
    if (this.startTime > this.endTime) {
      return "Start time must be less than or equal to end time";
    }
    if (this.startTime < 0) {
      return "Start time must be greater than or equal to 1";
    }
    if (this.endTime > this.maxTimePoint) {
      return "End time must be less than or equal to the maximum time point";
    }
    if (this.fps < 1 || this.fps > 30) {
      return "Frames per second must be between 1 and 30";
    }
    if (this.endTime - this.startTime > 200) {
      return "Time range cannot exceed 200 frames";
    }
    return "";
  }

  handleDownload() {
    if (this.warningText) {
      return;
    }

    this.$emit("download", {
      startTime: this.startTime,
      endTime: this.endTime,
      fps: this.fps,
      format: this.downloadFormat,
    });
    this.dialog = false;
  }
}
</script>
