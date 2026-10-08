<script setup lang="ts">
import { iconPaths as paths, type IconName } from '~/composables/office/icons'
defineProps<{ name: IconName; size?: 'sm' | 'lg' }>()
</script>
<template>
  <svg
    class="icon"
    :class="size ? `icon-${size}` : undefined"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name]" />
  </svg>
</template>
