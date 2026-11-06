<script setup lang="ts">
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { useOfficeAction, useOfficeToast } from '~/composables/office/actions'
import { when } from '~/composables/office/format'
import { describeError } from '~/composables/office/errors'
import {
  describeTradingRules,
  type TradingInstructionsView,
  type ApplyInstructionsResult,
} from '../../../core/contracts/trading-instructions'
type Role = {
  id: string
  name: string
  instruction: string
  model: string
  revision: number
  effectivePrompt: string
}
type View = {
  defaultModel: string
  switchAvailable: boolean
  master: string
  roles: Role[]
  contexts: { id: string; role: string; title: string; content: string }[]
}
const props = withDefaults(defineProps<{ tradingOnly?: boolean }>(), { tradingOnly: false })
const route = useRoute()
const { data, pending, status, refresh } = useOfficeResource<View>(
  () => 'model-profiles',
  () => officeFetch('/api/office/models'),
)
const { busy, error, run } = useOfficeAction()
const { show } = useOfficeToast()
const selected = ref(props.tradingOnly ? 'manager' : String(route.query.role || 'director'))
const managesTrading = computed(() => selected.value === 'manager')
const {
  data: appliedInstructions,
  refresh: refreshInstructions,
  status: instructionsStatus,
  pending: instructionsPending,
} = useOfficeResource<TradingInstructionsView>(
  () => (managesTrading.value ? 'trading-instructions' : null),
  () => officeFetch('/api/office/trading-instructions'),
)
const instructionIssues = ref<string[]>([])
let pendingApply: {
  fingerprint: string
  body: {
    requestId: string
    role: string
    instruction: string
    model: string
    revision: number
    instructionsRevision: number
  }
} | null = null
const visibleContexts = computed(() =>
  (data.value?.contexts ?? []).filter((c) => !props.tradingOnly || c.role === 'manager'),
)
const active = computed(() => data.value?.roles.find((r) => r.id === selected.value))
const instruction = ref('')
const model = ref('')
const revision = ref(0)
const dirty = ref(false)
const models = ref<{ id: string; name: string; browser: boolean }[]>([])
const catalogLoaded = ref(false)
watch(
  active,
  (value) => {
    if (!value || dirty.value) return
    instruction.value = value.instruction
    model.value = value.model
    revision.value = value.revision
  },
  { immediate: true },
)
function choose(event: Event) {
  dirty.value = false
  selected.value = (event.target as HTMLSelectElement).value
}
async function catalog() {
  await run(
    'catalog',
    async () => {
      models.value = await officeFetch('/api/office/models/catalog')
      catalogLoaded.value = true
    },
    'Каталог обновлён.',
  )
}
async function save() {
  const saved = await run('profile', async () => {
    const body = {
      role: selected.value,
      instruction: instruction.value,
      model: model.value,
      revision: revision.value,
    }
    instructionIssues.value = []
    if (managesTrading.value) {
      if (!appliedInstructions.value) return false
      const payload = { ...body, instructionsRevision: appliedInstructions.value.revision }
      const fingerprint = JSON.stringify({
        role: body.role,
        instruction: body.instruction,
        model: body.model,
      })
      if (pendingApply?.fingerprint !== fingerprint)
        pendingApply = { fingerprint, body: { ...payload, requestId: crypto.randomUUID() } }
      let result: ApplyInstructionsResult
      try {
        result = await officeFetch<ApplyInstructionsResult>('/api/office/trading-instructions', {
          method: 'POST',
          body: pendingApply.body,
          timeout: 135000,
        })
      } catch (e) {
        const info = describeError(e)
        if (info.status >= 400 && info.status < 500 && info.code !== 'TRADING_INSTRUCTIONS_BUSY')
          pendingApply = null
        throw e
      }
      pendingApply = null
      instructionIssues.value = result.issues
      if (!result.applied) return false
      revision.value = result.current.profileRevision
      await refreshInstructions()
    } else await officeFetch('/api/office/models', { method: 'POST', body })
    dirty.value = false
    await refresh()
    return true
  })
  if (saved)
    show(
      managesTrading.value
        ? 'Применено. Трейдеры проверяют новую версию перед следующими действиями.'
        : 'Сохранено. Настройки применятся в следующем запуске.',
    )
}
const title = ref('')
const content = ref('')
const target = ref(props.tradingOnly ? 'manager' : String(route.query.role || 'director'))
const fileError = ref('')
async function upload(event: Event) {
  fileError.value = ''
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!/\.(txt|md|csv)$/i.test(file.name) || file.size > 12000) {
    fileError.value = 'Подойдёт TXT, Markdown или CSV в UTF-8, до 12 КБ.'
    return
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    if (text.includes('\0')) throw new Error('BINARY')
    content.value = text
    title.value = file.name.slice(0, 120)
  } catch {
    fileError.value = 'Не удалось прочитать текст UTF-8.'
  }
}
async function add() {
  await run(
    'context',
    async () => {
      await officeFetch('/api/office/models/context', {
        method: 'POST',
        body: { role: target.value, title: title.value, content: content.value },
      })
      title.value = ''
      content.value = ''
      await refresh()
    },
    'Контекст добавлен.',
  )
}
async function remove(id: string) {
  await run(
    `delete-${id}`,
    async () => {
      await officeFetch(`/api/office/models/context/${id}`, { method: 'DELETE', body: {} })
      await refresh()
    },
    'Контекст удалён из следующих запусков. История выполненных задач сохранена.',
  )
}
function download() {
  if (!data.value) return
  const text = data.value.roles
    .filter((r) => !props.tradingOnly || r.id === 'manager')
    .map(
      (r) => `# ${r.name}\nМодель: ${r.model || data.value!.defaultModel}\n\n${r.effectivePrompt}`,
    )
    .join('\n\n---\n\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = props.tradingOnly ? 'trading-instructions.txt' : 'agent-prompts.txt'
  a.click()
  URL.revokeObjectURL(url)
}
</script>
<template>
  <div class="agent-workspace">
    <div class="page-head">
      <div>
        <h1>{{ tradingOnly ? 'Инструкции для торговли' : 'Модели и контекст' }}</h1>
        <p>
          {{
            tradingOnly
              ? 'Напишите правила обычным текстом и примените их к работающим спотовым трейдерам.'
              : 'Инструкции, выбор модели и материалы для каждой роли.'
          }}
        </p>
      </div>
      <button class="btn" :disabled="!data" @click="download">
        {{ tradingOnly ? 'Скачать промпт менеджера' : 'Скачать все промпты' }}
      </button>
    </div>
    <p v-if="tradingOnly" class="note note-wait guidance-note">
      После сохранения поддерживаемые правила действуют перед следующими торговыми действиями на
      всех биржах в Paper, Demo и уже разрешённом Live. Перезапуск не нужен. Ниже видно, что именно
      применяется. Новая инструкция полностью заменяет предыдущие дополнительные правила.
    </p>
    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <div v-else class="workspace">
      <section class="card instruction-card">
        <h2>{{ tradingOnly ? 'Правила торговли' : 'Настройка роли' }}</h2>
        <template v-if="!tradingOnly">
          <label for="model-role">Роль</label
          ><select
            id="model-role"
            class="select"
            :value="selected"
            :disabled="!!busy"
            @change="choose"
          >
            <option v-for="r in data.roles" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
          <p class="small muted">
            Разведчики используют общую инструкцию роли и собственные отрасли и параметры из раздела
            «Агенты». Поиск, биржевые стратегии и контролёр бюджета выполняются кодом и не являются
            отдельными моделями.
          </p>
        </template>
        <form v-if="active" class="workspace-form" @submit.prevent="save">
          <OfficeState
            v-if="managesTrading && !appliedInstructions"
            :status="instructionsStatus"
            :pending="instructionsPending"
            @retry="refreshInstructions"
          />
          <details class="model-settings" :open="!tradingOnly">
            <summary>
              {{ tradingOnly ? 'Модель для разбора и анализа' : 'Модель для роли' }}
            </summary>
            <div class="workspace-form">
              <label for="role-model">Модель</label>
              <select
                id="role-model"
                v-model="model"
                class="select"
                :disabled="!!busy || !data.switchAvailable"
                @change="dirty = true"
              >
                <option value="">Серверная по умолчанию · {{ data.defaultModel }}</option>
                <option v-if="model && !models.some((m) => m.id === model)" :value="model">
                  {{ model }}
                </option>
                <option
                  v-for="m in models.filter((m) => selected !== 'browser' || m.browser)"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.name }} · {{ m.id }}
                </option>
              </select>
              <button
                v-if="data.switchAvailable"
                type="button"
                class="btn btn-sm"
                :disabled="!!busy"
                @click="catalog"
              >
                {{ catalogLoaded ? 'Обновить каталог моделей' : 'Загрузить доступные модели' }}
              </button>
              <p class="small muted">
                {{
                  data.switchAvailable
                    ? 'Список содержит модели с нужным форматом ответа и в пределах тарифа сервера. Браузеру дополнительно нужны изображения и вызов функций. Доступность конкретного маршрута проверяется провайдером при запросе.'
                    : 'Выбор модели доступен при подключении платного OpenRouter на сервере.'
                }}
              </p>
            </div>
          </details>
          <label for="role-instruction">{{
            tradingOnly ? 'Правила торговли, ограничения и подход' : 'Ваши инструкции для роли'
          }}</label
          ><textarea
            id="role-instruction"
            v-model="instruction"
            class="textarea"
            rows="8"
            maxlength="6000"
            :disabled="!!busy"
            @input="dirty = true"
            :placeholder="
              managesTrading
                ? 'Например: не покупать BTC; покупка не больше 7 USDT; стоп-лосс 1%.'
                : 'На какой аудитории сосредоточиться, какой результат проверить, чего избегать'
            "
          />
          <p v-if="!managesTrading" class="small muted">
            Эти уточнения дополняют обязательные правила. Модель не получает право менять бюджет,
            включать Live или обходить закон. Начатый запуск завершится со своим набором инструкций.
          </p>
          <p v-else class="small muted">
            Правила не запускают остановленную торговлю и не меняют капитал или допуск к Live.
            Защитные выходы сохраняются. Отправленную на биржу заявку отменить задним числом нельзя.
            Свободную формулировку разбирает настроенная модель в пределах общего бюджета; точные
            команды из примеров применяются без вызова модели.
          </p>
          <div v-if="instructionIssues.length" class="note note-wait" role="alert">
            <strong>Не применено. Прежние правила продолжают действовать.</strong>
            <ul>
              <li v-for="issue in instructionIssues" :key="issue">{{ issue }}</li>
            </ul>
          </div>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <button
            class="btn btn-primary"
            :disabled="
              !!busy ||
              (managesTrading
                ? !appliedInstructions ||
                  (!dirty && appliedInstructions.synchronized && !!appliedInstructions.appliedAt)
                : !dirty)
            "
          >
            {{
              managesTrading
                ? busy === 'profile'
                  ? 'Разбираем и применяем…'
                  : 'Сохранить и применить'
                : 'Сохранить настройки роли'
            }}
          </button>
        </form>
        <section
          v-if="managesTrading && appliedInstructions"
          class="applied-rules"
          aria-label="Применённые торговые инструкции"
          aria-live="polite"
        >
          <h3>
            {{
              appliedInstructions.appliedAt
                ? `Действует версия ${appliedInstructions.revision}`
                : 'Дополнительные торговые правила пока не применены'
            }}
          </h3>
          <p v-if="!appliedInstructions.synchronized" class="note note-wait">
            Сохранённый текст ещё не применён к трейдерам. Нажмите «Сохранить и применить».
          </p>
          <p v-if="appliedInstructions.appliedAt" class="small muted">
            Применено {{ when(appliedInstructions.appliedAt) }}. Действуют и обязательные
            ограничения сервера.
          </p>
          <ul v-if="describeTradingRules(appliedInstructions.rules).length">
            <li v-for="rule in describeTradingRules(appliedInstructions.rules)" :key="rule">
              {{ rule }}
            </li>
          </ul>
          <p v-else-if="appliedInstructions.appliedAt" class="small">
            Дополнительных ограничений для сделок нет.
          </p>
          <template v-if="appliedInstructions.managerNotes.length">
            <p class="small">Рекомендации для анализа Paper-менеджером:</p>
            <ul>
              <li v-for="note in appliedInstructions.managerNotes" :key="note">{{ note }}</li>
            </ul>
          </template>
          <p class="small muted">
            Изменение инструкции и материалов запрашивает новый разбор у включённого менеджера. Он
            начнётся при доступном бюджете и с соблюдением лимитов частоты; устаревшие предложения
            больше не применяются.
          </p>
          <details>
            <summary>Примеры и доступные правила</summary>
            <p>
              Монеты, семейства стратегий, сумма покупки 5–10 USDT, доля капитала в позициях до 50%,
              число заявок до 40 в сутки, пауза между покупками, стоп до 3%, фиксация прибыли
              0,5–6%, срок удержания до 24 часов. Фильтр стратегий выбирает из уже работающих
              агентов; сетка и DCA доступны только в Paper.
            </p>
            <pre>
Не покупать BTC
Покупка не больше 7 USDT
Стоп-лосс 1%
Тейк-профит 2%
Пауза между покупками 60 минут</pre>
            <p class="small muted">
              Неизвестные, неоднозначные или противоречивые условия не применяются. Чтобы снять
              дополнительные правила, очистите поле и сохраните. Материалы ниже используются
              менеджером для анализа; торговые запреты указывайте в инструкции.
            </p>
          </details>
        </section>
        <details v-if="active">
          <summary>Используемый системный промпт · {{ active.name }}</summary>
          <pre>{{ active.effectivePrompt }}</pre>
          <p class="small muted">
            К нему сервер добавляет схему ответа, конкретное задание и выбранный контекст. Материалы
            клиентов не входят в скачивание промптов.
          </p>
        </details>
      </section>
      <section id="context" class="card context-card">
        <h2>{{ tradingOnly ? 'Материалы для торговли' : 'Контекст для агента' }}</h2>
        <p class="small muted">
          {{
            tradingOnly
              ? 'Добавьте описание стратегии, анализ рынка или результаты прошлых торговых экспериментов. Материалы получит только торговый менеджер; общий контекст доступен в разделе «Модели и контекст».'
              : 'Например, описание рынка, навыки команды, желаемая аудитория и результаты прошлых тестов.'
          }}
          Материалы передаются выбранному провайдеру модели. Не загружайте пароли и ключи. До 20
          записей и 16 000 символов суммарно.
        </p>
        <form class="workspace-form" @submit.prevent="add">
          <template v-if="!tradingOnly">
            <label for="context-target">Кому передать</label
            ><select id="context-target" v-model="target" class="select">
              <option value="all">Всем ролям</option>
              <option v-for="r in data.roles" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
          </template>
          <label for="context-file" class="file-upload">
            <OfficeIcon name="report" />
            <span
              ><strong>Загрузить текстовый файл</strong
              ><small>TXT, Markdown или CSV · до 12 КБ</small></span
            >
            <input id="context-file" type="file" accept=".txt,.md,.csv" @change="upload" />
          </label>
          <p v-if="fileError" class="error" role="alert">{{ fileError }}</p>
          <label for="context-title">Название</label
          ><input id="context-title" v-model="title" class="input" maxlength="120" required />
          <label for="context-content">Текст или содержимое файла</label
          ><textarea
            id="context-content"
            v-model="content"
            class="textarea"
            rows="8"
            maxlength="12000"
            required
          />
          <button class="btn btn-primary" :disabled="!!busy || !content.trim() || !title.trim()">
            Добавить контекст
          </button>
        </form>
        <article v-for="item in visibleContexts" :key="item.id" class="context-item">
          <strong>{{ item.title }}</strong>
          <p class="small muted">
            {{
              item.role === 'all' ? 'Все роли' : data.roles.find((r) => r.id === item.role)?.name
            }}
          </p>
          <details>
            <summary>Прочитать</summary>
            <pre>{{ item.content }}</pre>
          </details>
          <button class="btn btn-sm" :disabled="!!busy" @click="remove(item.id)">
            Удалить контекст
          </button>
        </article>
        <p v-if="!visibleContexts.length" class="context-empty">Материалы пока не добавлены.</p>
        <p class="small muted">
          Удалённый материал больше не добавляется в новые запуски. Уже начатая задача, результаты и
          резервные копии могут сохранять ранее полученные данные.
        </p>
      </section>
    </div>
  </div>
</template>
<style scoped>
.agent-workspace {
  max-width: 1160px;
}
.workspace > .card {
  min-width: 0;
  padding: 28px;
}
.workspace h2 {
  margin-bottom: 20px;
}
.instruction-card > label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
}
.instruction-card > .small {
  margin: 12px 0 24px;
}
.workspace-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.workspace-form > label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  margin-top: 8px;
}
.workspace-form > .btn {
  align-self: flex-start;
  margin-top: 4px;
}
.workspace-form > .small {
  line-height: 1.6;
}
.model-settings {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--canvas);
}
.model-settings[open] > summary {
  margin-bottom: 16px;
}
.workspace details > summary {
  cursor: pointer;
  font-weight: 600;
  line-height: 1.5;
}
.workspace details > p,
.workspace details > pre {
  margin-top: 14px;
}
.workspace details > pre {
  background: var(--canvas);
  padding: 16px;
  border-radius: var(--r-sm);
}
.applied-rules {
  margin-top: 28px;
  padding: 20px;
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.applied-rules > * + * {
  margin-top: 16px;
}
.applied-rules h3 {
  font-size: 16px;
  line-height: 1.5;
}
.applied-rules li + li {
  margin-top: 8px;
}
.instruction-card > details {
  margin-top: 24px;
}
.context-card > .small {
  margin-bottom: 24px;
}
.context-card > p:last-child {
  margin-top: 16px;
}
.file-upload {
  position: relative;
  display: flex !important;
  align-items: center;
  gap: 14px;
  padding: 20px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-md);
  background: var(--canvas);
  cursor: pointer;
}
.file-upload:focus-within {
  box-shadow: var(--ring);
}
.file-upload small {
  display: block;
  font-weight: 400;
  color: var(--muted);
  margin-top: 4px;
}
.file-upload .icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}
.file-upload input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.context-empty {
  margin-top: 24px;
  padding: 16px;
  text-align: center;
  border-radius: var(--r-md);
  background: var(--canvas);
  color: var(--muted);
  font-size: 14px;
}
.agent-workspace .btn {
  white-space: normal;
  text-align: center;
  padding-top: 10px;
  padding-bottom: 10px;
}
.guidance-note {
  margin-bottom: 24px;
}
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 520px;
  overflow: auto;
  font-size: 13px;
}
.context-item {
  border-top: 1px solid var(--line);
  padding-top: 16px;
  margin-top: 24px;
}
input[type='file'] {
  max-width: 100%;
}
@media (max-width: 1100px) {
  .workspace {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 600px) {
  .workspace > .card {
    padding: 20px;
  }
  .applied-rules {
    padding: 16px;
  }
  .agent-workspace .page-head > .btn {
    width: 100%;
  }
  .workspace-form > .btn {
    width: 100%;
  }
}
</style>
