<script setup lang="ts">
const props = defineProps<{ productId: string }>()
const versions = ref<any[]>([])
const nextBefore = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await $fetch<{ versions: any[]; nextBefore: number | null }>(
      `/api/products/${props.productId}/versions`,
      { query: nextBefore.value ? { before: nextBefore.value } : undefined },
    )
    versions.value.push(...result.versions)
    nextBefore.value = result.nextBefore
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
function open(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !versions.value.length) void load()
}
</script>

<template>
  <details class="product-preview" @toggle="open">
    <summary>История версий</summary>
    <p class="muted small-text">
      Новые заказы используют текущую версию. Принятые заказы сохраняют свою. Прежние обещания
      пользы — гипотезы, они не подтверждают рост продаж.
    </p>
    <article v-for="version in versions" :key="version.version" class="product-version">
      <strong>V{{ version.version }} · {{ version.spec.name }}</strong>
      <p>
        {{ dateTime(version.created_at) }} ·
        {{ version.is_demo ? 'Демонстрация' : version.model || 'Модель не записана' }}
      </p>
      <p>Аудитория: {{ version.spec.audience }}</p>
      <p>Формулировка версии: {{ version.spec.promise }}</p>
      <p v-if="version.critique">
        Критик: {{ labels[version.critique.verdict] }}. {{ version.critique.reason }}
      </p>
      <p v-if="version.checks?.reason">Проверка примера: {{ version.checks.reason }}</p>
      <p v-if="version.checks?.input">Исходный материал: {{ version.checks.input }}</p>
      <pre v-if="version.checks?.sample">{{ version.checks.sample }}</pre>
    </article>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <button v-if="nextBefore || error" class="quiet" :disabled="busy" @click="load">
      {{ error ? 'Повторить' : 'Предыдущие версии' }}
    </button>
    <p v-if="busy" role="status">Загружаем версии…</p>
  </details>
</template>
