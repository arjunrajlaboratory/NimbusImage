<template>
  <v-container :class="{ 'pa-0': embedded, 'fill-height': embedded }">
    <v-card
      :class="{
        'elevation-0': embedded,
        'd-flex': embedded,
        'flex-column': embedded,
        'fill-height': embedded,
      }"
    >
      <v-card-title
        v-if="!embedded"
        class="d-flex justify-space-between align-center"
        id="zenodo-community-display-tourstep"
      >
        Sample Datasets
        <v-btn icon @click="$emit('close')">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </v-card-title>
      <v-card-text
        :class="{
          'pt-0': embedded,
          'flex-grow-1': embedded,
          'overflow-y-auto': embedded,
        }"
      >
        <v-alert v-if="loading" type="info" text>
          Loading sample datasets...
        </v-alert>

        <v-alert v-if="error" type="error" text>
          {{ error }}
        </v-alert>

        <template v-if="community">
          <v-row>
            <v-col cols="12">
              <div class="d-flex align-center mb-4">
                <img
                  v-if="community.logo_url"
                  :src="community.logo_url"
                  class="mr-3"
                  height="40"
                  alt="Community logo"
                />
                <div>
                  <h3 class="text-h5 mb-1">{{ community.title }}</h3>
                  <p class="mb-0">{{ community.description }}</p>
                </div>
              </div>
            </v-col>
          </v-row>
        </template>

        <!-- Dataset Cards -->
        <div v-if="datasets.length > 0" class="dataset-list">
          <v-card
            v-for="dataset in datasets"
            :key="dataset.id"
            outlined
            hover
            class="sample-dataset-card mb-3"
            @click="selectDataset(dataset)"
            :id="getTourStepId(dataset.title)"
            v-tour-trigger="getTourTriggerId(dataset.title)"
          >
            <v-card-title class="pb-2">{{ dataset.title }}</v-card-title>
            <v-card-subtitle class="pb-2">
              <v-chip
                x-small
                class="mr-1"
                v-for="(creator, index) in dataset.metadata.creators"
                :key="index"
              >
                {{ creator.name }}
              </v-chip>
              <div class="mt-1">
                Published: {{ formatDate(dataset.created) }}
              </div>
            </v-card-subtitle>
            <v-card-text class="pt-0">
              <div
                class="text-truncate-3"
                v-html="dataset.metadata.description"
              ></div>
              <div class="mt-2">
                <v-chip small color="primary" class="mr-1">
                  {{ dataset.files.length }} files
                </v-chip>
                <v-chip small>
                  {{ formatSize(getTotalSize(dataset.files)) }}
                </v-chip>
              </div>
            </v-card-text>
          </v-card>
        </div>

        <!-- Pagination -->
        <v-pagination
          v-if="totalPages > 1"
          v-model="currentPage"
          :length="totalPages"
          @input="fetchCommunityRecords"
          total-visible="7"
          class="mt-4"
        ></v-pagination>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import store from "@/store";
import ZenodoAPI, {
  IZenodoRecord,
  IZenodoFile,
  IZenodoCommunity,
} from "@/store/ZenodoAPI";
import { logError } from "@/utils/log";
import { getTourStepId, getTourTriggerId } from "@/utils/strings";

@Component
export default class ZenodoCommunityDisplay extends Vue {
  @Prop({ default: "nimbusimagesampledatasets" })
  readonly communityId!: string;

  @Prop({ default: 10 })
  readonly pageSize!: number;

  @Prop({ default: false })
  readonly embedded!: boolean;

  private zenodoApi = new ZenodoAPI(store.girderRestProxy);

  getTourStepId = getTourStepId;
  getTourTriggerId = getTourTriggerId;

  community: IZenodoCommunity | null = null;
  datasets: IZenodoRecord[] = [];

  loading = true;
  error = "";

  currentPage = 1;
  totalPages = 1;
  totalRecords = 0;

  async mounted() {
    await this.fetchCommunity();
    await this.fetchCommunityRecords();
  }

  async fetchCommunity() {
    this.loading = true;
    this.error = "";

    try {
      this.community = await this.zenodoApi.getCommunity(this.communityId);
    } catch (err) {
      this.error = "Failed to load community information.";
      logError("Failed to fetch Zenodo community", err);
    }
  }

  async fetchCommunityRecords() {
    this.loading = true;
    this.error = "";

    try {
      const response = await this.zenodoApi.getCommunityRecords(
        this.communityId,
        this.currentPage,
        this.pageSize,
      );

      this.datasets = response.hits.hits;
      this.totalRecords = response.hits.total;
      this.totalPages = Math.ceil(this.totalRecords / this.pageSize);
    } catch (err) {
      this.error = "Failed to load sample datasets.";
      logError("Failed to fetch Zenodo community records", err);
    } finally {
      this.loading = false;
    }
  }

  selectDataset(dataset: IZenodoRecord) {
    this.$emit("dataset-selected", dataset);
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString();
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  getTotalSize(files: IZenodoFile[]): number {
    return files.reduce((total, file) => total + file.size, 0);
  }
}
</script>

<style scoped>
.dataset-list {
  display: flex;
  flex-direction: column;
}

.sample-dataset-card {
  transition:
    transform 0.2s,
    box-shadow 0.2s;
  cursor: pointer;
  width: 100%;
}

.sample-dataset-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2) !important;
}

.text-truncate-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 4.5em;
}
</style>
