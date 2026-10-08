<script setup lang="ts">
import type { Badge } from '~/composables/office/labels'
defineProps<{ badge: Badge; dot?: boolean }>()
</script>
<template>
  <span
    class="badge"
    :class="[badge.tone !== 'plain' ? `badge-${badge.tone}` : '', { 'badge-plain': dot === false }]"
    >{{ badge.label }}</span
  >
</template>
