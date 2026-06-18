<template>
  <tr
    @mouseover="emit('hover', item.annotation.id)"
    @mouseleave="emit('hover', null)"
    @click="emit('navigate', item.annotation.id)"
    title="Go to annotation location"
    :class="item.annotation.id === hoveredId ? 'is-hovered' : ''"
  >
    <td :class="tableItemClass">
      <v-checkbox
        hide-details
        title
        :model-value="item.isSelected"
        @click.stop="() => emit('toggle-select', item.annotation)"
      />
    </td>
    <td
      :class="tableItemClass"
      v-if="selectedColumns.includes('annotation.id')"
    >
      <span class="user-select-text">{{ item.annotation.id }}</span>
    </td>
    <td :class="tableItemClass" v-if="selectedColumns.includes('index')">
      <span>{{ item.index }}</span>
    </td>
    <td :class="tableItemClass" v-if="selectedColumns.includes('shapeName')">
      <span>{{ item.shapeName }}</span>
    </td>
    <td
      :class="tableItemClass"
      v-if="selectedColumns.includes('annotation.tags')"
    >
      <span>
        <v-chip
          v-for="tag in item.annotation.tags"
          :key="tag"
          size="x-small"
          @click="emit('clicked-tag', tag)"
          >{{ tag }}</v-chip
        >
      </span>
    </td>
    <td v-if="selectedColumns.includes('annotation.location.XY')">
      {{ item.annotation.location.XY + 1 }}
    </td>
    <td v-if="selectedColumns.includes('annotation.location.Z')">
      {{ item.annotation.location.Z + 1 }}
    </td>
    <td v-if="selectedColumns.includes('annotation.location.Time')">
      {{ item.annotation.location.Time + 1 }}
    </td>
    <td
      :class="tableItemClass"
      v-if="selectedColumns.includes('annotation.name')"
    >
      <v-text-field
        hide-details
        :model-value="item.annotation.name || ''"
        density="compact"
        flat
        variant="outlined"
        @change="
          emit('update-name', {
            name: ($event.target as HTMLInputElement).value,
            id: item.annotation.id,
          })
        "
        @click.capture.stop
        title
      ></v-text-field>
    </td>
    <td
      v-for="(propertyPath, idx) in displayedPropertyPaths"
      :key="item.annotation.id + ' property ' + idx"
      :class="tableItemClass"
    >
      <span>{{
        getStringFromPropertiesAndPath(item.properties, propertyPath) ?? "-"
      }}</span>
    </td>
  </tr>
</template>

<script lang="ts" setup>
import { IAnnotationLocation, IAnnotationPropertyValues } from "@/store/model";
import { getStringFromPropertiesAndPath } from "@/utils/paths";

// The subset of an annotation the row renders. Works for both client-mode
// items (full IAnnotation) and server-mode rows (stub + name), which both
// carry id/name/tags/location.
interface IRowAnnotation {
  id: string;
  name: string | null;
  tags: string[];
  location: IAnnotationLocation;
}

export interface IAnnotationListRowItem {
  annotation: IRowAnnotation;
  index: number;
  shapeName: string;
  isSelected: boolean;
  properties: IAnnotationPropertyValues[string];
}

defineProps<{
  item: IAnnotationListRowItem;
  selectedColumns: string[];
  displayedPropertyPaths: string[][];
  hoveredId: string | null;
  tableItemClass: string;
}>();

const emit = defineEmits<{
  (e: "hover", id: string | null): void;
  (e: "navigate", id: string): void;
  (e: "toggle-select", annotation: IRowAnnotation): void;
  (e: "clicked-tag", tag: string): void;
  (e: "update-name", payload: { name: string; id: string }): void;
}>();
</script>
