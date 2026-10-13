<script setup lang="ts">
import type { TradingView } from '../../../core/contracts/trading'
import { exchangeCatalog } from '../../../core/trading/catalog'
const props = defineProps<{
  view: TradingView
  busy: string
  offline: boolean
  startReady: boolean
}>()
defineEmits<{ action: [action: string]; start: []; overview: [] }>()
const venue = computed(() => exchangeCatalog[props.view.exchange])
const checks = computed(() => {
  const v = props.view
  return [
    { label: 'Ключи аккаунта настроены', ok: v.readiness.keys },
    { label: 'Связь, баланс и права проверены', ok: v.readiness.connection },
    ...(v.mode === 'live'
      ? [
          { label: 'Выделен бюджет для торговли', ok: v.readiness.allocated },
          { label: 'Тестовая покупка и продажа прошли успешно', ok: v.readiness.demoVerified },
          { label: 'Есть прибыльная тренировочная стратегия', ok: v.readiness.paperQualified },
          { label: 'Реальная торговля разрешена', ok: v.readiness.liveEnabled },
        ]
      : []),
  ]
})
</script>
<template>
  <section class="t-stack connection-content">
    <template v-if="view.mode === 'paper'">
      <div class="t-panel t-stack">
        <h2>Тренировка на ценах {{ venue.name }}</h2>
        <p>
          Цены приходят напрямую с {{ venue.name }}. Четыре стратегии пробуют покупать и продавать
          на виртуальный бюджет {{ view.metrics.capital }} USDT.
        </p>
        <p class="t-muted">
          Нажмите «Результат», чтобы запустить бота или посмотреть, как он работает. Для тестового и
          настоящего счёта выберите другой режим сверху.
        </p>
        <div>
          <button class="t-button t-primary" @click="$emit('overview')">К тренировке</button>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="section-heading">
        <div>
          <h2>
            {{
              view.mode === 'demo'
                ? `Подключите тестовый счёт ${venue.name}`
                : `Подключение к ${venue.name}`
            }}
          </h2>
          <p class="t-muted">
            {{
              view.mode === 'demo'
                ? `У этой биржи тестовый режим называется ${venue.demoName}.`
                : 'Деньги остаются на бирже. Приложение получает только доступ к торговле.'
            }}
          </p>
        </div>
      </div>
      <section class="t-panel t-stack" aria-label="Состояние подключения">
        <h3>Состояние подключения</h3>
        <p v-if="!view.readiness.keys" class="t-muted">
          Счёт не подключён. Обратитесь к администратору для настройки доступа к бирже.
        </p>
        <ul class="connection-checks">
          <li v-for="check in checks" :key="check.label">
            <span class="check-mark" :class="{ ready: check.ok }" aria-hidden="true">{{
              check.ok ? '✓' : '·'
            }}</span
            ><span>{{ check.label }}</span
            ><small>{{ check.ok ? 'Готово' : 'Ожидает' }}</small>
          </li>
        </ul>
        <p v-if="view.mode === 'live' && view.readiness.paperOnlyCandidate" class="t-notice">
          Сетка и DCA работают только в тренировке. Для реального счёта нужна другая стратегия с
          подходящими результатами.
        </p>
        <div class="t-actions">
          <button
            class="t-button"
            :disabled="!!busy || offline || !view.readiness.keys"
            @click="$emit('action', 'check')"
          >
            {{ busy === 'check' ? 'Проверяем…' : 'Проверить подключение' }}</button
          ><button
            v-if="view.mode === 'demo'"
            class="t-button t-primary"
            :disabled="!!busy || offline || !view.readiness.keys || view.status === 'running'"
            @click="$emit('action', 'demo_probe')"
          >
            {{ busy === 'demo_probe' ? 'Запускаем…' : 'Проверить покупку и продажу' }}</button
          ><button
            v-else-if="startReady"
            class="t-button t-primary"
            :disabled="!!busy || offline"
            @click="$emit('start')"
          >
            Начать торговлю
          </button>
        </div>
        <p class="t-muted">
          {{
            view.mode === 'demo'
              ? 'Проверка покупает и продаёт до 10 тестовых USDT, сверяет баланс и ставит бота на паузу.'
              : 'Для допуска стратегия должна работать в тренировке от 7 дней, завершить 20 покупок с продажей, остаться в плюсе и иметь просадку не выше 8%.'
          }}
        </p>
      </section>
      <slot />
      <details class="t-details">
        <summary>Параметры счёта</summary>
        <div class="t-details-body">
          <ol class="setup-steps">
            <li>
              <strong>Отдельный аккаунт или субаккаунт</strong>
              <p>{{ venue.account }}. Без ручной торговли и других ботов.</p>
            </li>
            <li>
              <strong>{{
                view.mode === 'demo' ? 'Тестовый API-ключ' : 'Ключ для реальной торговли'
              }}</strong>
              <p>
                Разрешите чтение и торговлю, отключите вывод.
                {{
                  view.mode === 'live'
                    ? 'Привяжите ключ к IP сервера.'
                    : 'Обычный ключ от реального счёта не подойдёт.'
                }}
                {{ venue.passphrase ? 'Также нужна парольная фраза API.' : '' }}
              </p>
            </li>
            <li>
              <strong>{{
                view.mode === 'demo'
                  ? `${view.metrics.capital} тестовых USDT`
                  : `Выделенный бюджет: ${view.metrics.capital} USDT`
              }}</strong>
              <p>
                {{
                  view.mode === 'live' && !view.readiness.allocated
                    ? 'Сначала укажите сумму в «Бюджете на биржи».'
                    : 'Внесите эту сумму на торговый счёт биржи.'
                }}
                Перед первым запуском на нём должны быть только USDT.
              </p>
            </li>
          </ol>
          <a
            class="t-link"
            :href="
              view.mode === 'demo' && view.exchange === 'binance'
                ? 'https://testnet.binance.vision/'
                : venue.apiUrl
            "
            target="_blank"
            rel="noopener noreferrer"
            >Открыть настройки {{ venue.name }} <OfficeIcon name="external"
          /></a>
        </div>
      </details>
    </template>
  </section>
</template>
