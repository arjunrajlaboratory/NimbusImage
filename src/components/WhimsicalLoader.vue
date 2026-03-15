<template>
  <div
    class="whimsical-loader"
    :class="[`whimsical-loader--${size}`, color !== 'auto' && `whimsical-loader--color-${color}`]"
    role="status"
    aria-label="Loading"
  >
    <div class="whimsical-loader__animation" :class="[`animation-${selectedAnimation}`]">
      <!-- Tiny Atom: one nucleus + one orbiting electron -->
      <template v-if="selectedAnimation === 'tiny-atom'">
        <div class="tiny-atom">
          <div class="tiny-atom__nucleus"></div>
          <div class="tiny-atom__orbit">
            <div class="tiny-atom__electron"></div>
          </div>
        </div>
      </template>

      <!-- DNA Helix: two strands of dots twisting -->
      <template v-else-if="selectedAnimation === 'dna-helix'">
        <div class="dna-helix">
          <div v-for="i in 8" :key="i" class="dna-helix__pair" :style="{ animationDelay: `${(i - 1) * -0.3}s` }">
            <div class="dna-helix__dot dna-helix__dot--left"></div>
            <div class="dna-helix__bar"></div>
            <div class="dna-helix__dot dna-helix__dot--right"></div>
          </div>
        </div>
      </template>

      <!-- Bubbling Beaker: flask outline with rising bubbles -->
      <template v-else-if="selectedAnimation === 'bubbling-beaker'">
        <div class="beaker">
          <div class="beaker__body">
            <div class="beaker__liquid">
              <div v-for="i in 4" :key="i" class="beaker__bubble" :style="{ animationDelay: `${(i - 1) * 0.7}s`, left: `${15 + (i * 17)}%` }"></div>
            </div>
          </div>
          <div class="beaker__neck"></div>
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

      <!-- Orbiting Atom: nucleus with electron orbits -->
      <template v-else-if="selectedAnimation === 'orbiting-atom'">
        <div class="atom">
          <div class="atom__nucleus"></div>
          <div class="atom__orbit atom__orbit--1">
            <div class="atom__electron"></div>
          </div>
          <div class="atom__orbit atom__orbit--2">
            <div class="atom__electron"></div>
          </div>
          <div class="atom__orbit atom__orbit--3">
            <div class="atom__electron"></div>
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
  "dna-helix",
  "bubbling-beaker",
  "newtons-cradle",
  "orbiting-atom",
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
  props.size === "sm"
    ? "tiny-atom"
    : MD_LG_ANIMATIONS[Math.floor(Math.random() * MD_LG_ANIMATIONS.length)],
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

// --- Tiny Atom Animation ---
.tiny-atom {
  position: relative;
  width: 100%;
  height: 100%;
}

.tiny-atom__nucleus {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 25%;
  height: 25%;
  background: currentColor;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.tiny-atom__orbit {
  position: absolute;
  top: 10%;
  left: 10%;
  width: 80%;
  height: 80%;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  opacity: 0.4;
  animation: tiny-atom-spin 1.5s linear infinite;
}

.tiny-atom__electron {
  position: absolute;
  top: -3px;
  left: 50%;
  width: 20%;
  height: 20%;
  background: currentColor;
  border-radius: 50%;
  transform: translateX(-50%);
}

@keyframes tiny-atom-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

// --- DNA Helix Animation ---
.dna-helix {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 2px;
  width: 100%;
  height: 100%;
}

.dna-helix__pair {
  display: flex;
  align-items: center;
  gap: 1px;
  animation: dna-twist 2.5s ease-in-out infinite;
}

.dna-helix__dot {
  width: 15%;
  height: 0;
  padding-bottom: 15%;
  background: currentColor;
  border-radius: 50%;
  flex-shrink: 0;
}

.dna-helix__bar {
  height: 1.5px;
  background: currentColor;
  opacity: 0.3;
  flex-grow: 1;
}

@keyframes dna-twist {
  0%, 100% { transform: scaleX(1); }
  25% { transform: scaleX(0.3); }
  50% { transform: scaleX(1); }
  75% { transform: scaleX(0.3); }
}

// --- Bubbling Beaker Animation ---
.beaker {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
}

.beaker__body {
  width: 70%;
  height: 60%;
  border: 2px solid currentColor;
  border-top: none;
  border-radius: 0 0 15% 15%;
  position: relative;
  overflow: hidden;
}

.beaker__liquid {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 65%;
  background: currentColor;
  opacity: 0.2;
}

.beaker__bubble {
  position: absolute;
  bottom: 0;
  width: 15%;
  padding-bottom: 15%;
  background: currentColor;
  border-radius: 50%;
  opacity: 0.5;
  animation: bubble-rise 3s ease-in infinite;
}

.beaker__neck {
  width: 45%;
  height: 12%;
  border: 2px solid currentColor;
  border-bottom: none;
  border-radius: 2px 2px 0 0;
}

@keyframes bubble-rise {
  0% { transform: translateY(0) scale(0.5); opacity: 0; }
  10% { opacity: 0.5; }
  80% { opacity: 0.3; }
  100% { transform: translateY(-200%) scale(1); opacity: 0; }
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

// --- Orbiting Atom Animation ---
.atom {
  position: relative;
  width: 100%;
  height: 100%;
}

.atom__nucleus {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18%;
  height: 18%;
  background: currentColor;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.atom__orbit {
  position: absolute;
  top: 10%;
  left: 10%;
  width: 80%;
  height: 80%;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  opacity: 0.3;
}

.atom__orbit--1 {
  animation: atom-spin 2s linear infinite;
}

.atom__orbit--2 {
  transform: rotate(60deg);
  animation: atom-spin-2 2s linear infinite;
}

.atom__orbit--3 {
  transform: rotate(120deg);
  animation: atom-spin-3 2s linear infinite;
}

.atom__electron {
  position: absolute;
  top: -4px;
  left: 50%;
  width: 14%;
  height: 14%;
  background: currentColor;
  border-radius: 50%;
  transform: translateX(-50%);
}

@keyframes atom-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes atom-spin-2 {
  from { transform: rotate(60deg); }
  to { transform: rotate(420deg); }
}

@keyframes atom-spin-3 {
  from { transform: rotate(120deg); }
  to { transform: rotate(480deg); }
}

// --- Reduced motion for all ---
@media (prefers-reduced-motion: reduce) {
  .dna-helix__pair,
  .beaker__bubble,
  .cradle__arm--left,
  .cradle__arm--right,
  .atom__orbit--1,
  .atom__orbit--2,
  .atom__orbit--3,
  .tiny-atom__orbit {
    animation: none;
  }

  .dna-helix__bar,
  .beaker__neck,
  .beaker__liquid,
  .atom__orbit,
  .cradle__arm::before {
    opacity: 0;
  }

  .dna-helix__pair:not(:nth-child(4)),
  .cradle__arm:not(:nth-child(3)) {
    visibility: hidden;
  }

  .atom__nucleus,
  .tiny-atom__nucleus,
  .dna-helix__pair:nth-child(4) .dna-helix__dot--left,
  .beaker__body,
  .cradle__arm:nth-child(3) .cradle__ball {
    animation: pulse-reduced 1.5s ease-in-out infinite;
  }
}

@keyframes pulse-reduced {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
</style>
