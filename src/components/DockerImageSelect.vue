<template>
  <!-- image -->
  <v-select
    :items="items"
    dense
    v-model="image"
    label="Algorithm"
    :menu-props="{ maxHeight: 500 }"
  >
    <template v-slot:item="item">
      <div>
        <div>{{ item.item.text }}</div>
        <div v-if="item.item.description" :style="{ color: 'grey' }">
          {{ item.item.description }}
        </div>
      </div>
    </template>
  </v-select>
</template>

<script lang="ts">
import { Vue, Component, VModel, Prop } from "vue-property-decorator";
import store from "@/store";
import propertiesStore from "@/store/properties";
import { IWorkerLabels } from "@/store/model";

interface IDockerImageSelectEntry {
  text: string;
  value: string;
  description: string | undefined;
}

// Interface element selecting an image
@Component({
  components: {},
})
export default class DockerImageSelect extends Vue {
  readonly store = store;
  readonly propertyStore = propertiesStore;

  @VModel({ type: String }) image!: String;

  @Prop()
  readonly imageFilter!: { (labels: IWorkerLabels): boolean };

  get images() {
    return this.propertyStore.workerImageList;
  }

  get items() {
    const imagesPerCategory: {
      [category: string]: IDockerImageSelectEntry[];
    } = {};
    for (const image in this.images) {
      const labels = this.images[image];
      if (this.imageFilter(labels)) {
        const category = labels.interfaceCategory || "No category";
        if (!imagesPerCategory[category]) {
          imagesPerCategory[category] = [];
        }
        imagesPerCategory[category].push({
          text: labels.interfaceName || image,
          value: image,
          description: labels.description,
        });
      }
    }
    const items = [];
    for (const category in imagesPerCategory) {
      items.push(
        { divider: true },
        { header: category },
        ...imagesPerCategory[category],
      );
    }
    return items;
  }

  mounted() {
    this.propertyStore.fetchWorkerImageList();
  }
}
</script>
