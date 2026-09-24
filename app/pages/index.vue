<script setup lang="ts">
const { state: d, refresh } = useFarm()
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
async function control(action: string) {
  busy.value = true
  actionError.value = ''
  message.value = ''
  try {
    const response = await $fetch<any>('/api/control', {
      method: 'POST',
      body: action === 'simulate' ? { action, generation: d.value.state.generation } : { action },
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
const activeStrategies = computed(
  () => d.value?.strategies?.filter((s: any) => s.status === 'active') || [],
)
const roleNames: Record<string, string> = {
  search: 'Поиск',
  Исследователь: 'Исследователь',
  Критик: 'Критик',
  Архитектор: 'Архитектор',
  Исполнитель: 'Исполнитель',
  Проверяющий: 'Проверяющий',
}
const sourceHost = (url: string) => new URL(url).hostname
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
          d.state.mode === 'running' ? 'Автономный режим включён' : labels[d.state.mode]
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
                  : 'Модель и поиск используют подключённый API; расходы учитываются в общем бюджете.'
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
        @research="control('research')"
      />
      <template v-if="view === 'overview'">
        <section class="metrics" aria-label="Показатели">
          <article>
            <span>Активных сервисов</span
            ><strong
              >{{ d.products.filter((p: any) => p.status === 'sandbox').length
              }}<small>/ 3</small></strong
            >
            <p>В пределах конструктора</p>
          </article>
          <article>
            <span>Рабочих стратегий</span
            ><strong>{{ activeStrategies.length }}<small>/ 4</small></strong>
            <p>Поколение {{ d.state.generation }}</p>
          </article>
          <article>
            <span>Расходы API за месяц</span><strong>{{ rub(d.budget.monthSpent) }}</strong>
            <p>Лимит {{ rub(d.config.monthlyLimit) }}</p>
          </article>
          <article>
            <span>Реальная выручка</span><strong>{{ rub(d.realRevenueKopecks) }}</strong>
            <p>Тестовые средства исключены</p>
          </article>
        </section>
        <div class="two-columns">
          <section class="panel">
            <div class="section-heading">
              <h2>Команда стратегий</h2>
              <NuxtLink to="/?view=strategies">Все стратегии ↗</NuxtLink>
            </div>
            <div class="strategy-list">
              <div v-for="(s, i) in activeStrategies" :key="s.id" class="strategy-row">
                <span class="strategy-avatar" :class="'shade-' + i">{{ s.name.slice(0, 1) }}</span>
                <div>
                  <strong>{{ s.name }}</strong>
                  <p>{{ s.approach }}</p>
                </div>
                <span class="tag">{{ s.test_delivered }} тест.</span>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="section-heading">
              <h2>Контроль эксперимента</h2>
              <span class="tiny-label">POLICY V1</span>
            </div>
            <div class="budget-line">
              <span>API сегодня</span
              ><strong>{{ rub(d.budget.daySpent) }} / {{ rub(d.config.dailyLimit) }}</strong>
            </div>
            <div class="budget-track">
              <i
                :style="{
                  width: Math.min(100, (d.budget.daySpent / d.config.dailyLimit) * 100) + '%',
                }"
              />
            </div>
            <p class="muted small-text">
              В резервах: {{ rub(d.budget.outstanding) }}. Один бюджет на всю команду.
            </p>
            <div class="evaluation-callout">
              <span>Недельная оценка</span
              ><strong>{{
                d.evaluations[0] ? labels[d.evaluations[0].decision] : 'Ожидает первого запуска'
              }}</strong>
              <p>
                {{
                  d.evaluations[0]?.reason ||
                  'Денежный победитель появится только после достаточных сопоставимых продаж.'
                }}
              </p>
            </div>
            <div class="control-buttons">
              <button
                class="button secondary small"
                :disabled="busy"
                @click="control(d.state.mode === 'running' ? 'paused' : 'running')"
              >
                {{ d.state.mode === 'running' ? 'Ⅱ Приостановить' : '▶ Продолжить' }}</button
              ><button
                class="button danger small"
                :disabled="busy || d.state.mode === 'emergency_stop'"
                @click="control('emergency_stop')"
              >
                Остановить
              </button>
            </div>
            <p class="muted small-text">
              Пауза завершает принятые заказы. Стоп приостанавливает исполнение; история и
              обязательства сохраняются.
            </p>
          </section>
        </div>
        <section class="panel">
          <div class="section-heading">
            <h2>Последние события</h2>
            <NuxtLink to="/?view=audit">Открыть журнал ↗</NuxtLink>
          </div>
          <div v-if="!d.audit.length" class="empty">
            События появятся после первого запуска worker.
          </div>
          <div v-for="event in d.audit.slice(0, 5)" :key="event.id" class="event-row">
            <span class="event-dot" /><span>{{ event.message }}</span
            ><time>{{ dateTime(event.created_at) }}</time>
          </div>
        </section>
      </template>
      <template v-else-if="view === 'hypotheses'">
        <div class="section-heading">
          <p class="muted">Каждая идея хранит основания, возражения и способ опровержения.</p>
          <button
            class="button primary"
            :disabled="busy || d.state.mode !== 'running' || !d.state.research_enabled"
            @click="control('research')"
          >
            Запустить исследование
          </button>
        </div>
        <div v-if="!d.hypotheses.length" class="panel empty large">
          Пока нет гипотез. Нажмите «Новое исследование» в пульте лаборатории.
        </div>
        <article v-for="h in d.hypotheses" :key="h.id" class="panel hypothesis">
          <div class="section-heading">
            <div>
              <span class="eyebrow">{{
                h.is_demo ? 'ДЕМО · СПРОС НЕ ПРОВЕРЕН' : 'ИССЛЕДОВАНИЕ · ПОИСКОВЫЕ ФРАГМЕНТЫ'
              }}</span>
              <h2>{{ h.title }}</h2>
            </div>
            <span class="status-pill" :class="h.status === 'accepted' ? 'good' : 'warn'">{{
              labels[h.status]
            }}</span>
          </div>
          <p>{{ h.research.hypothesis }}</p>
          <div class="hypothesis-grid">
            <div>
              <h3>Покупатель и проблема</h3>
              <p>{{ h.research.audience }}. {{ h.research.problem }}</p>
            </div>
            <div>
              <h3>Причина сомневаться</h3>
              <p>{{ h.research.counterargument }}</p>
            </div>
            <div>
              <h3>Как проверить</h3>
              <p>{{ h.research.experiment }}</p>
            </div>
            <div>
              <h3>Решение критика · {{ labels[h.critique.verdict] }}</h3>
              <p>{{ h.critique.reason }}</p>
            </div>
          </div>
          <div class="evidence-list">
            <strong>Источники</strong
            ><a
              v-for="e in h.evidence"
              :key="e.url"
              :href="e.url"
              target="_blank"
              rel="noopener noreferrer"
              >{{ e.title }} ↗
              <small>{{ sourceHost(e.url) }} · {{ dateTime(e.observedAt) }}</small></a
            >
          </div>
          <p class="muted small-text">{{ h.research.uncertainties.join(' ') }}</p>
        </article>
      </template>
      <template v-else-if="view === 'strategies'">
        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">ПОКОЛЕНИЕ {{ d.state.generation }}</span>
              <h2>Отбор по результату</h2>
            </div>
            <span class="tag">4 активных места</span>
          </div>
          <p>
            Раз в неделю система оценивает данные. При достаточной выборке две слабые стратегии
            архивируются, а два лидера создают по одной копии. Без реальных продаж — HOLD.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Стратегия</th>
                  <th>Подход</th>
                  <th>Поколение</th>
                  <th>Тестовых выдач</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in d.strategies" :key="s.id">
                  <td>
                    <strong>{{ s.name }}</strong
                    ><small v-if="s.parent_id">Копия · {{ s.parent_id.slice(0, 8) }}</small>
                  </td>
                  <td>{{ s.approach }}</td>
                  <td>{{ s.generation }}</td>
                  <td>{{ s.test_delivered }}</td>
                  <td>
                    <span class="tag">{{ labels[s.status] }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section class="panel simulation-panel">
          <div>
            <span class="eyebrow">ОТДЕЛЬНАЯ ДЕМОНСТРАЦИЯ</span>
            <h2>Проверить смену поколения</h2>
            <p>
              Симуляция заменит две стратегии на фиксированных учебных данных. История и заказы
              сохранятся, финансовый журнал не изменится.
            </p>
          </div>
          <button
            class="button secondary"
            :disabled="busy || d.state.mode !== 'running'"
            @click="control('simulate')"
          >
            Симулировать отбор 50%
          </button>
        </section>
        <section class="panel">
          <h2>История оценок</h2>
          <div v-for="e in d.evaluations" :key="e.id" class="event-row">
            <span class="tag">{{ labels[e.decision] }}</span
            ><span>{{ e.reason }}</span
            ><time>{{ dateTime(e.created_at) }}</time>
          </div>
          <p v-if="!d.evaluations.length" class="empty">
            Первая оценка появится после запуска worker.
          </p>
        </section>
      </template>
      <template v-else-if="view === 'orders'">
        <section class="panel">
          <div class="section-heading">
            <h2>Тестовые заказы</h2>
            <NuxtLink to="/catalog">Создать заказ ↗</NuxtLink>
          </div>
          <p class="muted">Все суммы в тестовом ETH. Данные не включаются в реальную выручку.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Сервис</th>
                  <th>Стратегия</th>
                  <th>Статус</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="o in d.orders" :key="o.id">
                  <td>
                    <NuxtLink :to="'/orders/' + o.id">{{ o.id.slice(0, 8) }} ↗</NuxtLink>
                  </td>
                  <td>{{ o.product_snapshot.name }}</td>
                  <td>{{ o.strategy_snapshot.name }}</td>
                  <td>
                    <span class="tag">{{ labels[o.status] }}</span>
                  </td>
                  <td>{{ dateTime(o.created_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="!d.orders.length" class="empty large">
            Заказов ещё нет. Пройдите тестовый путь покупателя в витрине.
          </div>
        </section>
      </template>
      <template v-else-if="view === 'audit'">
        <section class="panel">
          <h2>Очередь заданий</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Задание</th>
                  <th>Статус</th>
                  <th>Попытка</th>
                  <th>Причина остановки</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="j in d.jobs" :key="j.id">
                  <td>
                    {{ labels[j.kind] }} <small>{{ j.id.slice(0, 8) }}</small>
                  </td>
                  <td>{{ labels[j.status] }}</td>
                  <td>{{ j.attempts }} / 3</td>
                  <td>{{ j.error_code || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section class="panel">
          <h2>Вызовы инструментов</h2>
          <div v-for="(call, i) in d.toolCalls" :key="i" class="event-row">
            <span class="tag">{{ roleNames[call.role] || call.role }}</span
            ><span
              >{{
                call.is_demo
                  ? 'Демонстрация'
                  : call.status === 'uncertain'
                    ? 'Исход неизвестен, резерв учтён'
                    : 'API'
              }}
              · {{ rub(call.charged_kopecks) }}</span
            ><time>{{ dateTime(call.created_at) }}</time>
          </div>
        </section>
        <section class="panel">
          <h2>Журнал решений</h2>
          <div v-for="event in d.audit" :key="event.id" class="event-row">
            <span class="event-dot" /><span>{{ event.message }}</span
            ><time>{{ dateTime(event.created_at) }}</time>
          </div>
        </section>
      </template>
    </template>
  </FarmShell>
</template>
