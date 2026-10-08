<script setup lang="ts">
import type { IconName } from '~/composables/office/icons'
defineProps<{ title: string; text?: string; icon?: IconName }>()
</script>
<template>
  <div class="empty">
    <OfficeIcon v-if="icon" :name="icon" size="lg" />
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>
