<script setup lang="ts">
import type { Template } from '../../core/policy'
import DashboardOverview from '~/components/dashboard/Overview.vue'
import DashboardHypotheses from '~/components/dashboard/Hypotheses.vue'
import DashboardStrategies from '~/components/dashboard/Strategies.vue'
import DashboardOrders from '~/components/dashboard/Orders.vue'
import DashboardAudit from '~/components/dashboard/Audit.vue'

const { state: d, refresh } = useFarm()
const researchTemplate = useState<Template | ''>('research-template', () => '')
const route = useRoute()
const view = computed(() => String(route.query.view || 'overview'))
const title = computed(
  () =>
    ({
      overview: 'Лаборатория продуктов',
      hypotheses: 'От предположения к проверке',
      strategies: 'Четыре подхода. Один эксперимент.',
      orders: 'Каждый заказ под наблюдением',
      audit: 'История решений',
    })[view.value] || 'Лаборатория',
)
const busy = ref(false),
  message = ref(''),
  actionError = ref('')
async function control(action: string, template?: Template) {
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
          ? 'Открыто уже выполняющееся исследование.'
          : 'Новое исследование поставлено в очередь. Этапы появятся в пульте лаборатории.'
        : 'Изменения сохранены.'
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
        <div class="eyebrow">
          {{ view === 'overview' ? 'ОБЗОР СИСТЕМЫ' : labels[view] || 'РАБОЧЕЕ ПРОСТРАНСТВО' }}
        </div>
        <h1>{{ title }}</h1>
        <p>От идеи до результата — с понятными правилами и сохранённой историей.</p>
      </div>
      <span v-if="d" class="status-pill" :class="d.state.mode === 'running' ? 'good' : 'warn'"
        ><span class="dot" />{{
          d.state.mode === 'running'
            ? d.config.autonomyEnabled
              ? 'Расписание включено'
              : 'Ручной запуск · расписание выключено'
            : labels[d.state.mode]
        }}</span
      >
    </div>
    <div v-if="message" class="notice" role="status">{{ message }}</div>
    <div v-if="actionError" class="notice error" role="alert">{{ actionError }}</div>
    <div v-if="!d" class="empty large">Загружаем состояние лаборатории…</div>
    <template v-else>
      <div v-if="!d.state.research_enabled" class="notice">
        28-дневное окно закрыто без подтверждённых продаж. Новые исследования остановлены; заказы
        сохраняются.
        <button class="quiet" :disabled="busy" @click="control('restart_research')">
          Открыть новое окно наблюдения →
        </button>
      </div>
      <div class="test-banner">
        <span class="banner-symbol">◎</span>
        <div>
          <strong>{{
            d.config.modelProvider === 'demo'
              ? 'Демонстрационный режим'
              : d.config.modelProvider === 'ollama'
                ? 'Локальная модель · живой поиск'
                : d.config.modelProvider === 'openai'
                  ? 'Облачная модель · ' + d.config.model
                  : 'Исследование через Yandex API'
          }}</strong
          ><span
            >{{
              d.config.modelProvider === 'demo'
                ? 'Гипотезы и тексты создаёт демонстрационный провайдер. Интернет пока не исследуется.'
                : d.config.modelProvider === 'ollama'
                  ? 'Ответы генерирует ' +
                    d.config.model +
                    '. Источники приходят из интернета. Качество небольшого локального ИИ требует проверки.'
                  : 'Ответы создаёт платная модель. Источники передаёт отдельный поиск; расходы видны в пульте.'
            }}
            Платежи —
            {{
              d.config.paymentMode === 'sandbox'
                ? 'имитация без переводов'
                : 'тестовый ETH в Sepolia'
            }}.</span
          >
        </div>
        <NuxtLink to="/catalog">Открыть витрину ↗</NuxtLink>
      </div>
      <LiveActivity
        v-if="view === 'overview' || view === 'hypotheses'"
        :busy="busy"
        @research="(template) => control('research', template)"
      />
      <DashboardOverview v-if="view === 'overview'" :busy="busy" @control="control" />
      <DashboardHypotheses v-else-if="view === 'hypotheses'" :busy="busy" @control="control" />
      <DashboardStrategies v-else-if="view === 'strategies'" :busy="busy" @control="control" />
      <DashboardOrders v-else-if="view === 'orders'" />
      <DashboardAudit v-else-if="view === 'audit'" />
    </template>
  </FarmShell>
</template>
