<script setup lang="ts">
const { state: d, failure, refresh } = useFarm()
const { services, serviceLabel } = useServiceCatalog()
const stages: Record<string, string> = {
  new: 'Нужно проверить',
  saved: 'Сохранено',
  contacted: 'Связались вне сервиса',
  won: 'Договорились вне сервиса',
  dismissed: 'Не подходит',
}
const selectedStage = ref(''),
  selectedTemplate = ref('')
const editing = ref(''),
  draftStage = ref('new'),
  draftNote = ref('')
const busy = ref(false),
  error = ref(''),
  message = ref('')
type OpportunityPage = {
  items: any[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}
const page = ref<OpportunityPage>(
  d.value.opportunities || { items: [], total: 0, offset: 0, limit: 50, hasMore: false },
)
const offset = ref(0),
  loading = ref(false),
  loadError = ref('')
let requestVersion = 0
const items = computed(() => page.value.items)
const selected = computed(() => items.value.find((item: any) => item.id === editing.value))
async function load() {
  const version = ++requestVersion
  loading.value = true
  loadError.value = ''
  try {
    const result = await $fetch<OpportunityPage>('/api/opportunities', {
      query: {
        offset: offset.value,
        ...(selectedStage.value ? { stage: selectedStage.value } : {}),
        ...(selectedTemplate.value ? { template: selectedTemplate.value } : {}),
      },
      timeout: 10000,
    })
    if (version !== requestVersion) return
    page.value = result
    if (!result.items.length && offset.value > 0) {
      offset.value = Math.max(0, Math.floor((result.total - 1) / result.limit) * result.limit)
      await load()
    }
  } catch (e: any) {
    if (version !== requestVersion) return
    if (e.statusCode === 401 || e.status === 401) await navigateTo('/login')
    else loadError.value = 'Не удалось обновить источники. Повторите загрузку.'
  } finally {
    if (version === requestVersion) loading.value = false
  }
}
onMounted(() => void load())
onUnmounted(() => {
  requestVersion++
})
watch([selectedStage, selectedTemplate], () => {
  offset.value = 0
  editing.value = ''
  void load()
})
async function turnPage(direction: number) {
  offset.value = Math.max(0, offset.value + direction * page.value.limit)
  editing.value = ''
  await load()
  document.querySelector('.catalog-filters')?.scrollIntoView({ block: 'start' })
}
function resetFilters() {
  selectedStage.value = ''
  selectedTemplate.value = ''
}
async function edit(item: any) {
  editing.value = item.id
  draftStage.value = item.stage
  draftNote.value = item.note || ''
  error.value = ''
  message.value = ''
  await nextTick()
  document.getElementById('opportunity-note')?.focus()
}
async function save(item: any, stage: string, note: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await $fetch('/api/opportunities/' + item.id, { method: 'POST', body: { stage, note } })
    await Promise.all([load(), refresh()])
    editing.value = ''
    message.value = 'Статус и заметка сохранены. Сообщения никому не отправлялись.'
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
function host(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return 'Источник'
  }
}
</script>

<template>
  <section class="panel portfolio-summary">
    <div>
      <h2>Сначала проверьте потребность</h2>
      <p>
        После исследования здесь сохраняются открытые источники по направлениям. Среди них могут
        быть предложения конкурентов и статьи. Это кандидаты для проверки, а не подтверждённые
        заявки или согласие на контакт.
      </p>
      <p class="muted small-text">
        Откройте источник, оцените актуальность и правила площадки. Связь с человеком и
        договорённости отмечаются вручную; письма, реклама и платежи отсюда не отправляются.
      </p>
    </div>
    <NuxtLink class="button secondary" to="/?view=directions">Исследовать направления →</NuxtLink>
  </section>
  <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  <p v-if="message" class="notice" role="status">{{ message }}</p>
  <p v-if="loadError" class="notice error" role="alert">
    {{ loadError }} <button class="quiet" @click="load">Повторить</button>
  </p>
  <div class="catalog-filters">
    <div>
      <label for="opportunity-stage">Ваш следующий шаг</label
      ><select id="opportunity-stage" v-model="selectedStage" :disabled="busy || loading">
        <option value="">Все статусы</option>
        <option v-for="(label, stage) in stages" :key="stage" :value="stage">{{ label }}</option>
      </select>
    </div>
    <div>
      <label for="opportunity-template">Направление</label
      ><select id="opportunity-template" v-model="selectedTemplate" :disabled="busy || loading">
        <option value="">Все направления</option>
        <option v-for="item in services" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>
    <span class="muted small-text" role="status">{{
      loading ? 'Обновляем…' : `Показано: ${items.length} · Найдено: ${page.total}`
    }}</span>
  </div>
  <p>
    <button class="button secondary small" :disabled="loading || busy" @click="load">
      Обновить источники
    </button>
  </p>
  <form
    v-if="selected"
    class="panel opportunity-form"
    @submit.prevent="save(selected, draftStage, draftNote)"
  >
    <div class="section-heading">
      <h2>Следующее действие</h2>
      <button type="button" class="quiet" @click="editing = ''">Закрыть ×</button>
    </div>
    <p>{{ selected.title }}</p>
    <label for="draft-stage">Статус</label
    ><select id="draft-stage" v-model="draftStage">
      <option v-for="(label, stage) in stages" :key="stage" :value="stage">
        {{ label }}
      </option></select
    ><label for="opportunity-note">Заметка и следующий шаг</label
    ><textarea
      id="opportunity-note"
      v-model="draftNote"
      maxlength="1000"
      rows="3"
      placeholder="Что нужно проверить, какой пример подготовить, когда вернуться"
    />
    <p class="muted small-text">
      До 1 000 символов, без личных данных и секретов. Отметка о договорённости не считается
      выручкой.
    </p>
    <button class="button primary" :disabled="busy || loading || !!failure">
      {{ busy ? 'Сохраняем…' : 'Сохранить изменения' }}
    </button>
  </form>
  <div
    v-if="!items.length && !loading && !selectedStage && !selectedTemplate && !loadError"
    class="panel empty large"
  >
    Пока нет источников для поиска клиентов.
    <NuxtLink to="/?view=directions">Запустите исследование направлений</NuxtLink>.
  </div>
  <div v-else-if="!items.length && !loading && !loadError" class="panel empty">
    По этим фильтрам записей нет.
    <button class="quiet" @click="resetFilters">Сбросить фильтры</button>
  </div>
  <div class="opportunity-list" :aria-busy="loading">
    <article v-for="item in items" :key="item.id" class="panel opportunity-card">
      <div class="section-heading">
        <span class="eyebrow">{{
          item.is_demo ? 'ДЕМО · ВЫМЫШЛЕННЫЙ ПРИМЕР' : 'ПОИСКОВЫЙ ФРАГМЕНТ · НЕ ПРОВЕРЕНО'
        }}</span
        ><span class="tag">{{ stages[item.stage] }}</span>
      </div>
      <h2>
        <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.title }} ↗</a>
      </h2>
      <p class="muted small-text">
        {{ serviceLabel(item.template) }} · {{ host(item.url) }} · Найдено
        {{ dateTime(item.first_seen_at) }}
      </p>
      <p>{{ item.snippet }}</p>
      <p v-if="item.note" class="opportunity-note preserve-text">{{ item.note }}</p>
      <div class="inline-actions">
        <button
          v-if="item.stage === 'new'"
          class="button secondary small"
          :disabled="busy || loading || !!failure"
          @click="save(item, 'saved', item.note || '')"
        >
          Сохранить</button
        ><button class="quiet" :disabled="busy || loading || !!failure" @click="edit(item)">
          Статус и заметка</button
        ><button
          v-if="item.stage !== 'dismissed'"
          class="quiet"
          :disabled="busy || loading || !!failure"
          @click="save(item, 'dismissed', item.note || '')"
        >
          Не подходит
        </button>
      </div>
    </article>
  </div>
  <nav
    v-if="page.total > page.limit || offset"
    class="inline-actions pagination"
    aria-label="Страницы источников"
  >
    <button
      class="button secondary small"
      :disabled="loading || busy || offset === 0"
      @click="turnPage(-1)"
    >
      ← Назад</button
    ><span class="muted small-text"
      >Страница {{ Math.floor(offset / page.limit) + 1 }} из
      {{ Math.max(1, Math.ceil(page.total / page.limit)) }}</span
    ><button
      class="button secondary small"
      :disabled="loading || busy || !page.hasMore"
      @click="turnPage(1)"
    >
      Далее →
    </button>
  </nav>
</template>
