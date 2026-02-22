<template>
  <v-card>
    <v-divider />
    <v-card-title> Documentation </v-card-title>
    <v-card-text>
      Read
      <a href="https://arjun-raj-lab.gitbook.io/nimbusimage" target="_blank">
        the documentation
      </a>
      for more information on how to use NimbusImage.
    </v-card-text>
    <v-card-title> Hotkeys </v-card-title>
    <v-card-text class="container">
      <p v-for="[sectionName, sectionItems] of hotkeyItems" :key="sectionName">
        <span class="title span-title">
          {{ sectionName }}
        </span>
        <br />
        <template v-for="({ key, description }, i) of sectionItems" :key="i">
          <code class="caption">{{ key }}</code>
          <span class="text-high-emphasis pl-2">
            {{ description }}
          </span>
          <br />
        </template>
      </p>
    </v-card-text>
    <v-divider />
    <v-card-title> Features </v-card-title>
    <v-card-text class="container">
      <p v-for="[sectionName, sectionItems] of featureItems" :key="sectionName">
        <span class="title span-title">
          {{ sectionName }}
        </span>
        <br />
        <template v-for="({ title, description }, i) of sectionItems" :key="i">
          <code class="caption">{{ title }}</code>
          <span class="text-high-emphasis pl-2">
            {{ description }}
          </span>
          <br />
        </template>
      </p>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { boundKeys } from "@/utils/v-mousetrap";
import { IFeatureDescription, descriptions } from "@/utils/v-description";

const hotkeyItems = computed(() => {
  const sections: Map<string, { key: string; description: string }[]> =
    new Map();
  for (const [key, data] of Object.entries(boundKeys.value)) {
    if (!sections.has(data.section)) {
      sections.set(data.section, []);
    }
    const section = sections.get(data.section);
    section!.push({
      key,
      description: data.description,
    });
  }
  const items = [...sections.entries()];
  items.sort();
  return items;
});

const featureItems = computed(() => {
  const sections: Map<string, IFeatureDescription[]> = new Map();
  for (const desc of Object.values(descriptions.value)) {
    if (!sections.has(desc.section)) {
      sections.set(desc.section, []);
    }
    const section = sections.get(desc.section);
    section!.push(desc);
  }
  const items = [...sections.entries()];
  items.sort();
  return items;
});

defineExpose({ hotkeyItems, featureItems });
</script>

<style lang="scss" scoped>
.container {
  column-width: 300px;
  column-gap: 20px;
  column-fill: balance;
  column-rule: inset;
  orphans: 4;
}

.span-title {
  line-height: 3em;
}
</style>
