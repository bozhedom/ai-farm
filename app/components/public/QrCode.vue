<script setup lang="ts">
import { encode } from 'uqr'

// QR code drawn locally as SVG: the payment link never goes to an outside service.
const props = defineProps<{ value: string; label: string }>()
const qr = computed(() => encode(props.value, { ecc: 'M', border: 2 }))
const path = computed(() => {
  const parts: string[] = []
  qr.value.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x} ${y}h1v1h-1z`)
    }),
  )
  return parts.join('')
})
</script>

<template>
  <svg
    class="qr"
    :viewBox="`0 0 ${qr.size} ${qr.size}`"
    role="img"
    :aria-label="props.label"
    shape-rendering="crispEdges"
  >
    <rect :width="qr.size" :height="qr.size" fill="#fff" />
    <path :d="path" fill="#171a21" />
  </svg>
</template>

<style scoped>
.qr {
  width: 100%;
  max-width: 200px;
  height: auto;
  aspect-ratio: 1;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
</style>
