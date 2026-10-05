<script setup lang="ts">
const { state: d, failure } = useFarm()
defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
</script>
<template>
  <section class="panel">
    <div class="section-heading">
      <h2>Модель и поиск</h2>
      <span class="tag">{{
        d.config.modelProvider === 'demo' ? 'Демонстрация' : 'Выбран провайдер'
      }}</span>
    </div>
    <dl class="settings-list">
      <div>
        <dt>Текущая модель</dt>
        <dd>{{ d.config.model }}</dd>
      </div>
      <div>
        <dt>Поиск</dt>
        <dd>
          {{
            d.config.searchProvider === 'demo'
              ? 'Демонстрационные источники'
              : d.config.searchProvider === 'searxng'
                ? 'SearXNG, поиск в интернете'
                : 'Yandex Search'
          }}
        </dd>
      </div>
      <div>
        <dt>Оплата заказов</dt>
        <dd>
          {{
            d.config.paymentMode === 'sandbox'
              ? 'Тестовая, без перевода денег'
              : 'Sepolia, тестовый ETH'
          }}
        </dd>
      </div>
    </dl>
    <p v-if="d.config.modelProvider === 'ollama'">
      Модель работает на вашем компьютере. Платы за запросы нет. Для автономной работы компьютер и
      Docker должны оставаться включёнными.
    </p>
    <p v-else-if="d.config.modelProvider === 'demo'">
      Это демонстрация: ответы заданы заранее. Для настоящих исследований запустите бесплатную
      локальную модель.
    </p>
    <p v-else-if="d.config.modelProvider === 'openrouter'">
      OpenRouter подключён в бесплатном режиме. Платные модели и запасные платные маршруты
      запрещены.
    </p>
    <p v-else>Используется платный API. Лимиты действуют на все задачи вместе.</p>
    <p v-if="d.budget.openrouterActualMicrousd > 0" class="notice error" role="alert">
      OpenRouter сообщил плату {{ usd(d.budget.openrouterActualMicrousd) }}. Новые запросы
      остановлены. Проверьте расходы в кабинете провайдера.
    </p>
    <details class="setup-details">
      <summary>Как подключить OpenRouter</summary>
      <p>Добавьте ключ в локальный файл <code>.env</code>. Не отправляйте его в чат.</p>
      <pre>
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=ваш_ключ
OPENROUTER_MODEL=openrouter/free
SEARCH_PROVIDER=searxng</pre>
      <p>Затем пересоздайте приложение и обработчик:</p>
      <pre>
docker compose -f compose.yaml -f compose.local.yaml --profile app up -d --build web worker observer</pre>
      <p>
        Первое подключение поддерживает только бесплатные модели. Они могут быть недоступны или
        ограничивать число запросов. Полная инструкция: <code>docs/13-openrouter.md</code>.
      </p>
    </details>
  </section>
  <section class="panel">
    <div class="section-heading">
      <h2>Лимиты расходов</h2>
      <span class="tag">Один бюджет на все задачи</span>
    </div>
    <dl class="settings-list">
      <div>
        <dt>Сегодня</dt>
        <dd>{{ rub(d.budget.daySpent) }} из {{ rub(d.config.dailyLimit) }}</dd>
      </div>
      <div>
        <dt>За месяц</dt>
        <dd>{{ rub(d.budget.monthSpent) }} из {{ rub(d.config.monthlyLimit) }}</dd>
      </div>
      <div>
        <dt>Зарезервировано</dt>
        <dd>{{ rub(d.budget.outstanding) }}</dd>
      </div>
    </dl>
    <p v-if="d.config.modelProvider === 'openai'">
      Общий предел OpenAI: {{ usd(d.budget.openaiSpentMicrousd) }} из
      {{ usd(d.config.openaiTotalLimitMicrousd) }}. Включает резервы и не обнуляется с началом
      месяца.
    </p>
    <p class="muted small-text">
      Резерв удерживает бюджет до завершения задачи. Расходы на компьютер, сервер и привлечение
      покупателей сюда не входят. Лимиты меняются в настройках сервера.
    </p>
  </section>
  <DashboardAutonomy :busy="busy" @control="emit('control', $event)" />
  <section class="panel">
    <div class="section-heading">
      <h2>Управление работой</h2>
      <NuxtLink to="/?view=strategies">Подходы и недельная оценка</NuxtLink>
    </div>
    <div class="control-buttons">
      <button
        class="button secondary"
        :disabled="busy || !!failure"
        @click="emit('control', d.state.mode === 'running' ? 'paused' : 'running')"
      >
        {{ d.state.mode === 'running' ? 'Пауза' : 'Продолжить работу' }}</button
      ><button
        class="button danger"
        :disabled="busy || !!failure || d.state.mode === 'emergency_stop'"
        @click="emit('control', 'emergency_stop')"
      >
        Остановить всё
      </button>
    </div>
    <p class="muted small-text">
      Пауза запрещает новые исследования и заказы, но завершает принятые. «Остановить всё» также
      останавливает новые обращения к модели. Уже отправленный запрос может завершиться; история и
      заказы сохраняются.
    </p>
  </section>
  <DashboardOperations :operations="d.autonomy.operations" />
</template>
