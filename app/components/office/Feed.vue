<script setup lang="ts">
import type { OfficeOverview } from '../../../core/contracts/office'
import { feedTone } from '~/composables/office/labels'
import { dayWord, isToday, splitSentence, time } from '~/composables/office/format'

const props = defineProps<{ items: OfficeOverview['feed']; limit?: number }>()
const rows = computed(() =>
  props.items.slice(0, props.limit ?? 12).map((item) => ({
    ...item,
    tone: feedTone(item.kind, item.text),
    label: isToday(item.at) ? time(item.at) : dayWord(item.at),
    ...splitSentence(item.text),
  })),
)
</script>
<template>
  <ul class="feed">
    <li v-for="(row, i) in rows" :key="`${row.at}:${i}`">
      <time :datetime="row.at">{{ row.label }}</time
      ><i class="dot" :class="row.tone !== 'plain' ? row.tone : ''" />
      <div class="text">
        <NuxtLink v-if="row.link" :to="row.link" class="feed-link">{{ row.main }}</NuxtLink
        ><template v-else>{{ row.main }}</template>
        <small v-if="row.rest">{{ row.rest }}</small>
      </div>
    </li>
  </ul>
</template>
<style scoped>
.feed-link {
  color: inherit;
}
.feed-link:hover {
  color: var(--brand);
}
</style>
