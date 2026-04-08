<template>
  <div
    class="whimsical-loader"
    :class="[`whimsical-loader--${size}`, color !== 'auto' && `whimsical-loader--color-${color}`]"
    role="status"
    aria-label="Loading"
  >
    <div class="whimsical-loader__animation" :class="[`animation-${selectedAnimation}`]">
      <!-- Bouncing Molecules: dots connected by lines, bouncing in wave -->
      <template v-if="selectedAnimation === 'bouncing-molecules'">
        <div class="molecules">
          <div v-for="i in 4" :key="i" class="molecules__node" :style="{ animationDelay: `${(i - 1) * 0.15}s` }">
            <div class="molecules__dot"></div>
            <div v-if="i < 4" class="molecules__bond"></div>
          </div>
        </div>
      </template>

      <!-- Newton's Cradle: swinging balls -->
      <template v-else-if="selectedAnimation === 'newtons-cradle'">
        <div class="cradle">
          <div v-for="i in 5" :key="i" class="cradle__arm" :class="{ 'cradle__arm--left': i === 1, 'cradle__arm--right': i === 5 }">
            <div class="cradle__ball"></div>
          </div>
        </div>
      </template>

    </div>
    <div v-if="displayText" class="whimsical-loader__text">
      {{ displayText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const MD_LG_ANIMATIONS = [
  "bouncing-molecules",
  "newtons-cradle",
] as const;

const FUN_MESSAGES = [
  "Crunching pixels with extra enthusiasm...",
  "Teaching the computer to see...",
  "Consulting the literature...",
  "Sprinkling some digital magic...",
  "Doing science...",
  "Peer-reviewing your request...",
  "Running the gel... digitally...",
  "Calibrating the microscope...",
];

const props = withDefaults(
  defineProps<{
    size?: "sm" | "md" | "lg";
    text?: string;
    color?: "auto" | "light" | "dark";
  }>(),
  {
    size: "md",
    text: undefined,
    color: "auto",
  },
);

const selectedAnimation = ref(
  MD_LG_ANIMATIONS[Math.floor(Math.random() * MD_LG_ANIMATIONS.length)],
);

const randomMessage = ref(
  FUN_MESSAGES[Math.floor(Math.random() * FUN_MESSAGES.length)],
);

const displayText = computed(() => {
  if (props.size === "sm") return null;
  if (props.text !== undefined) return props.text;
  if (props.size === "lg") return randomMessage.value;
  return null;
});
</script>

<style lang="scss" scoped>
.whimsical-loader {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.whimsical-loader--sm {
  .whimsical-loader__animation {
    width: 20px;
    height: 20px;
  }
}

.whimsical-loader--md {
  .whimsical-loader__animation {
    width: 48px;
    height: 48px;
  }
}

.whimsical-loader--lg {
  .whimsical-loader__animation {
    width: 64px;
    height: 64px;
  }
}

.whimsical-loader--color-light {
  color: white;
}

.whimsical-loader--color-dark {
  color: rgba(0, 0, 0, 0.87);
}

.whimsical-loader__text {
  font-size: 0.85rem;
  opacity: 0.85;
  text-align: center;
  max-width: 250px;
}

// --- Bouncing Molecules Animation ---
.molecules {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.molecules__node {
  display: flex;
  align-items: center;
  animation: molecule-bounce 1.2s ease-in-out infinite;
}

.molecules__dot {
  width: 10px;
  height: 10px;
  background: currentColor;
  border-radius: 50%;
  flex-shrink: 0;
}

.molecules__bond {
  width: 6px;
  height: 2px;
  background: currentColor;
  opacity: 0.4;
  flex-shrink: 0;
}

.whimsical-loader--sm .molecules__dot {
  width: 4px;
  height: 4px;
}

.whimsical-loader--sm .molecules__bond {
  width: 3px;
  height: 1px;
}

@keyframes molecule-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-40%); }
}

// --- Newton's Cradle Animation ---
.cradle {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 0;
  width: 100%;
  height: 100%;
  padding-top: 15%;
}

.cradle__arm {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 14%;
  transform-origin: top center;

  &::before {
    content: "";
    width: 1.5px;
    height: 55%;
    background: currentColor;
    opacity: 0.4;
    display: block;
  }
}

.cradle__ball {
  width: 100%;
  padding-bottom: 100%;
  background: currentColor;
  border-radius: 50%;
}

.cradle__arm--left {
  animation: cradle-left 2s ease-in-out infinite;
}

.cradle__arm--right {
  animation: cradle-right 2s ease-in-out infinite;
}

@keyframes cradle-left {
  0% { transform: rotate(0deg); }
  25% { transform: rotate(-30deg); }
  50% { transform: rotate(0deg); }
  100% { transform: rotate(0deg); }
}

@keyframes cradle-right {
  0% { transform: rotate(0deg); }
  50% { transform: rotate(0deg); }
  75% { transform: rotate(30deg); }
  100% { transform: rotate(0deg); }
}

// --- Reduced motion for all ---
@media (prefers-reduced-motion: reduce) {
  .molecules__node,
  .cradle__arm--left,
  .cradle__arm--right {
    animation: none;
  }

  // Hide bonds and cradle strings
  .molecules__bond,
  .cradle__arm::before {
    opacity: 0;
  }

  // Hide all but one element
  .molecules__node:not(:nth-child(2)),
  .cradle__arm:not(:nth-child(3)) {
    visibility: hidden;
  }

  // Pulse the remaining visible element
  .molecules__node:nth-child(2) .molecules__dot,
  .cradle__arm:nth-child(3) .cradle__ball {
    animation: pulse-reduced 1.5s ease-in-out infinite;
  }
}

@keyframes pulse-reduced {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
</style>
