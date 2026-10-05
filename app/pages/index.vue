<script setup lang="ts">
import type { Template } from '../../core/policy'
const { state: d, refresh } = useFarm()
const researchTemplate = useState<Template | ''>('research-template', () => '')
const route = useRoute()
const pages: Record<string, { title: string; description: string }> = {
  overview: { title: 'Обзор', description: 'Идеи, готовые услуги и результаты работы.' },
  hypotheses: {
    title: 'Исследования',
    description: 'Что проверили, что получилось и почему отказались от идеи.',
  },
  strategies: {
    title: 'Подходы к работе',
    description: 'Четыре варианта инструкций и их результаты.',
  },
  orders: { title: 'Заказы', description: 'От исходного материала до готового текста.' },
  audit: { title: 'Журнал', description: 'Задания, расходы и причины остановки.' },
  settings: {
    title: 'Настройки и состояние',
    description: 'Подключения, расписание, лимиты и сохранность данных.',
  },
}
const view = computed(() =>
  typeof route.query.view === 'string' && pages[route.query.view] ? route.query.view : 'overview',
)
const busy = ref(false),
  message = ref(''),
  actionError = ref('')
async function control(action: string, template?: Template) {
  if (busy.value) return
  busy.value = true
  actionError.value = ''
  message.value = ''
  try {
    const response = await $fetch<any>('/api/control', {
      method: 'POST',
      body:
        action === 'simulate'
          ? { action, generation: d.value.state.generation }
          : action === 'research'
            ? { action, template: template || researchTemplate.value || undefined }
            : { action },
    })
    await refresh()
    message.value =
      action === 'research'
        ? response.reused
          ? 'Это исследование уже запущено. Следите за ним в разделе «Исследования».'
          : 'Идея поставлена на проверку. Ход работы появится в разделе «Исследования».'
        : (
            {
              running: 'Работа возобновлена.',
              paused: 'Новые задачи на паузе. Принятые заказы выполняются.',
              emergency_stop: 'Новые обращения к модели остановлены.',
              schedule_on: 'Автозапуск включён.',
              schedule_off: 'Автозапуск выключен.',
              restart_research: 'Начат новый эксперимент. История сохранена.',
              simulate: 'Две стратегии заменены на учебных данных. Деньги не учитывались.',
            } as Record<string, string>
          )[action] || 'Изменения сохранены.'
  } catch (e) {
    actionError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <FarmShell>
    <div class="page-heading">
      <div>
        <h1>{{ pages[view]!.title }}</h1>
        <p>{{ pages[view]!.description }}</p>
      </div>
      <span v-if="d" class="status-pill" :class="d.state.mode === 'running' ? 'good' : 'warn'"
        ><span class="dot" />{{ labels[d.state.mode] }}</span
      >
    </div>
    <div v-if="message" class="notice" role="status">{{ message }}</div>
    <div v-if="actionError" class="notice error" role="alert">{{ actionError }}</div>
    <div v-if="!d" class="empty large">Загружаем данные…</div>
    <template v-else>
      <div v-if="d.config.modelProvider === 'demo'" class="notice">
        Демонстрация: ответы заданы заранее, поиск в интернете не выполняется.
        <NuxtLink to="/?view=settings">Подключения</NuxtLink>
      </div>
      <div v-if="!d.state.research_enabled && view !== 'overview'" class="notice">
        За 28 дней нет подтверждённых продаж. Пересмотрите идею и начните новый эксперимент.<button
          class="quiet"
          :disabled="busy"
          @click="control('restart_research')"
        >
          Начать новый эксперимент
        </button>
      </div>
      <DashboardOverview v-if="view === 'overview'" :busy="busy" @control="control" />
      <template v-else-if="view === 'hypotheses'"
        ><details class="panel activity-details" :open="!!d.autonomy.activeRun">
          <summary>Ход работы и предыдущие запуски</summary>
          <LiveActivity :busy="busy" @research="(template) => control('research', template)" />
        </details>
        <DashboardHypotheses :busy="busy" @control="control"
      /></template>
      <DashboardStrategies v-else-if="view === 'strategies'" :busy="busy" @control="control" />
      <DashboardOrders v-else-if="view === 'orders'" />
      <DashboardAudit v-else-if="view === 'audit'" />
      <DashboardSettings v-else-if="view === 'settings'" :busy="busy" @control="control" />
    </template>
  </FarmShell>
</template>
