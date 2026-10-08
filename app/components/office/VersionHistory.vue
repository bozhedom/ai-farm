<script setup lang="ts">
import { productVersions, type ProductVersion } from '~/composables/office/data'
import { errorMessage } from '~/composables/office/errors'
import { when } from '~/composables/office/format'
import { verdict } from '~/composables/office/labels'

/** Saved product versions, loaded on first open. Old orders keep their own version. */
const props = defineProps<{ productId: string }>()
const versions = ref<ProductVersion[]>([])
const nextBefore = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
const loaded = ref(false)
async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await productVersions(props.productId, nextBefore.value)
    versions.value.push(...result.versions)
    nextBefore.value = result.nextBefore
    loaded.value = true
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
function onToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !loaded.value) void load()
}
const verdictLabel = (value: string) => verdict[value as keyof typeof verdict]?.title || 'Критик'
</script>
<template>
  <details class="history" @toggle="onToggle">
    <summary>История версий</summary>
    <p v-if="busy && !versions.length" class="small muted">Загружаем</p>
    <ol v-if="versions.length" class="versions">
      <li v-for="v in versions" :key="v.version">
        <div class="v-head">
          <strong>Версия {{ v.version }}</strong>
          <span class="small muted">{{ when(v.created_at) }}</span>
          <span v-if="v.is_demo" class="badge badge-plain">Демо</span>
        </div>
        <p class="small">{{ v.spec.name }}. {{ v.spec.promise }}</p>
        <p v-if="v.critique" class="small muted">
          {{ verdictLabel(v.critique.verdict) }}: {{ v.critique.reason }}
        </p>
        <p v-if="v.checks?.reason" class="small muted">Проверка примера: {{ v.checks.reason }}</p>
        <pre v-if="v.checks?.sample" class="sample">{{ v.checks.sample }}</pre>
      </li>
    </ol>
    <p v-else-if="loaded" class="small muted">Сохранённых версий нет.</p>
    <p v-if="error" class="small err" role="alert">{{ error }}</p>
    <button
      v-if="nextBefore || error"
      type="button"
      class="btn btn-ghost btn-sm"
      :disabled="busy"
      @click="load"
    >
      {{ error ? 'Повторить' : 'Ещё версии' }}
    </button>
  </details>
</template>
<style scoped>
.history summary {
  cursor: pointer;
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--brand);
}
.versions {
  list-style: none;
  margin: var(--s-3) 0 0;
  padding: 0;
  display: grid;
  gap: var(--s-3);
}
.versions li {
  border-left: 2px solid var(--line);
  padding-left: var(--s-3);
}
.v-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.sample {
  margin: 6px 0 0;
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border-radius: var(--r-sm);
  font: 400 var(--text-xs) / 1.5 var(--font-mono);
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
.err {
  color: var(--st-err-ink);
}
</style>
