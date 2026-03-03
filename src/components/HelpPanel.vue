<template>
  <div class="hud-overlay" @click.self="$emit('close')">
    <div class="hud-content">
      <div class="hud-header">
        <span class="hud-title">HUD</span>
        <span class="hud-subtitle">
          Read
          <a
            href="https://arjun-raj-lab.gitbook.io/nimbusimage"
            target="_blank"
          >
            the documentation
          </a>
          for more info
        </span>
        <v-btn
          icon
          variant="text"
          size="small"
          class="hud-close"
          @click="$emit('close')"
        >
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </div>

      <div class="hud-body">
        <div class="hud-section" v-if="hotkeyItems.length">
          <div class="section-title">Hotkeys</div>
          <div class="section-columns">
            <div
              v-for="[sectionName, sectionItems] of hotkeyItems"
              :key="sectionName"
              class="section-group"
            >
              <div class="group-title">{{ sectionName }}</div>
              <div
                v-for="({ key, description }, i) of sectionItems"
                :key="i"
                class="hotkey-row"
              >
                <kbd>{{ key }}</kbd>
                <span class="hotkey-desc">{{ description }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="hud-divider" v-if="featureItems.length" />

        <div class="hud-section" v-if="featureItems.length">
          <div class="section-title">Features</div>
          <div class="section-columns">
            <div
              v-for="[sectionName, sectionItems] of featureItems"
              :key="sectionName"
              class="section-group"
            >
              <div class="group-title">{{ sectionName }}</div>
              <div
                v-for="({ title, description }, i) of sectionItems"
                :key="i"
                class="hotkey-row"
              >
                <kbd>{{ title }}</kbd>
                <span class="hotkey-desc">{{ description }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { boundKeys } from "@/utils/v-mousetrap";
import { IFeatureDescription, descriptions } from "@/utils/v-description";

defineEmits<{ close: [] }>();

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
.hud-overlay {
  width: 100%;
  height: 100%;
  display: flex;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
}

.hud-content {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: rgba(20, 20, 20, 0.7);
  overflow: hidden;
}

.hud-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.hud-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.hud-subtitle {
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.45);

  a {
    color: rgba(100, 180, 255, 0.8);
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }
}

.hud-close {
  margin-left: auto;
  opacity: 0.5;
  &:hover {
    opacity: 1;
  }
}

.hud-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.hud-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 20px 0;
}

.section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: rgba(100, 180, 255, 0.7);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.section-columns {
  column-width: 320px;
  column-gap: 32px;
  column-fill: balance;
}

.section-group {
  break-inside: avoid;
  margin-bottom: 16px;
}

.group-title {
  font-size: 0.8rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.hotkey-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 0;
}

kbd {
  display: inline-block;
  min-width: 28px;
  padding: 2px 7px;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono",
    Consolas, monospace;
  font-size: 0.75rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  text-align: center;
  white-space: nowrap;
  line-height: 1.4;
  flex-shrink: 0;
}

.hotkey-desc {
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.55);
}
</style>
