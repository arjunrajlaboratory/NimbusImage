<template>
  <div class="server-status">
    <v-tooltip left>
      <template #activator="{ on }">
        <div v-on="on">
          <v-icon class="save" v-if="saving">mdi-database-sync</v-icon>
          <v-icon class="loading" v-else-if="loading">mdi-database-sync</v-icon>
          <v-icon v-else-if="lastError" color="error">
            mdi-database-alert
          </v-icon>
          <v-icon class="sync" v-else>mdi-database-check</v-icon>
        </div>
      </template>
      <span v-if="saving">Saving...</span>
      <span v-else-if="loading"> Loading...</span>
      <span v-else-if="lastError">{{ lastError }}</span>
      <span v-else>In sync with the server</span>
    </v-tooltip>
  </div>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import sync from "../store/sync";

@Component
export default class ServerStatus extends Vue {
  readonly store = sync;

  get lastError() {
    if (!this.store.lastError) {
      return "";
    }

    return this.store.lastError.message;
  }

  get loading() {
    return this.store.loading;
  }

  get saving() {
    return this.store.saving;
  }
}
</script>

<style lang="scss" scoped>
.server-status {
  margin: 8px;
  span {
    text-decoration: none;
  }

  &.dark {
    color: white;
  }
}

@keyframes save_animation {
  0% {
    transform: scale(1);
  }
  25% {
    transform: scale(1.15);
  }
  50% {
    transform: scale(1);
  }
  75% {
    transform: scale(0.85);
  }
  100% {
    transform: scale(1);
  }
}

.save {
  transition: opacity 0.5s ease;
  opacity: 0.85;
  animation-name: save_animation;
  animation-duration: 2s;
  animation-iteration-count: infinite;
  animation-timing-function: linear;
  color: #00bcd4;
}

.sync {
  transition: opacity 0.5s ease;
  opacity: 0.85;
  color: #ffffff;
}

.loading {
  transition: opacity 0.5s ease;
  opacity: 0.85;
  animation-name: save_animation;
  animation-duration: 2s;
  animation-iteration-count: infinite;
  animation-timing-function: linear;
  color: #00bcd4;
}
</style>
