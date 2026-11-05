<script setup lang="ts">
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { useOfficeAction } from '~/composables/office/actions'
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
useHead({ title: 'Модели и контекст' })
const route = useRoute()
const { data, pending, status, refresh } = useOfficeResource<View>(
  () => 'model-profiles',
  () => officeFetch('/api/office/models'),
)
const { busy, run } = useOfficeAction()
const selected = ref(String(route.query.role || 'director'))
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
  await run(
    'profile',
    async () => {
      await officeFetch('/api/office/models', {
        method: 'POST',
        body: {
          role: selected.value,
          instruction: instruction.value,
          model: model.value,
          revision: revision.value,
        },
      })
      dirty.value = false
      await refresh()
    },
    'Сохранено. Настройки применятся в следующем запуске.',
  )
}
const title = ref('')
const content = ref('')
const target = ref(String(route.query.role || 'director'))
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
    .map(
      (r) => `# ${r.name}\nМодель: ${r.model || data.value!.defaultModel}\n\n${r.effectivePrompt}`,
    )
    .join('\n\n---\n\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'agent-prompts.txt'
  a.click()
  URL.revokeObjectURL(url)
}
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Модели и контекст</h1>
        <p>Инструкции, выбор модели и материалы для каждой роли.</p>
      </div>
      <button class="btn" :disabled="!data" @click="download">Скачать все промпты</button>
    </div>
    <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
    <div v-else class="workspace">
      <section class="card stack-sm">
        <h2>Настройка роли</h2>
        <label for="model-role">Роль</label
        ><select id="model-role" class="select" :value="selected" @change="choose">
          <option v-for="r in data.roles" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <p class="small muted">
          Разведчики используют общую инструкцию роли и собственные отрасли и параметры из раздела
          «Агенты». Поиск, биржевые стратегии и контролёр бюджета выполняются кодом и не являются
          отдельными моделями.
        </p>
        <form v-if="active" class="stack-sm" @submit.prevent="save">
          <label for="role-model">Модель</label>
          <select
            id="role-model"
            v-model="model"
            class="select"
            :disabled="!data.switchAvailable"
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
          <label for="role-instruction">Ваши инструкции для роли</label
          ><textarea
            id="role-instruction"
            v-model="instruction"
            class="textarea"
            rows="8"
            maxlength="6000"
            @input="dirty = true"
            placeholder="На какой аудитории сосредоточиться, какой результат проверить, чего избегать"
          />
          <p class="small muted">
            Эти уточнения дополняют обязательные правила. Модель не получает право менять бюджет,
            включать Live или обходить закон. Начатый запуск завершится со своим набором инструкций.
          </p>
          <button class="btn btn-primary" :disabled="!!busy || !dirty">
            Сохранить настройки роли
          </button>
        </form>
        <details v-if="active">
          <summary>Используемый системный промпт · {{ active.name }}</summary>
          <pre>{{ active.effectivePrompt }}</pre>
          <p class="small muted">
            К нему сервер добавляет схему ответа, конкретное задание и выбранный контекст. Материалы
            клиентов не входят в скачивание промптов.
          </p>
        </details>
      </section>
      <section id="context" class="card stack-sm">
        <h2>Контекст для агента</h2>
        <p class="small muted">
          Например, описание рынка, навыки команды, желаемая аудитория и результаты прошлых тестов.
          Материалы передаются выбранному провайдеру модели. Не загружайте пароли и ключи. До 20
          записей и 16 000 символов суммарно.
        </p>
        <form class="stack-sm" @submit.prevent="add">
          <label for="context-target">Кому передать</label
          ><select id="context-target" v-model="target" class="select">
            <option value="all">Всем ролям</option>
            <option v-for="r in data.roles" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
          <label for="context-file">Загрузить текстовый файл</label
          ><input id="context-file" type="file" accept=".txt,.md,.csv" @change="upload" />
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
        <article v-for="item in data.contexts" :key="item.id" class="context-item">
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
        <p v-if="!data.contexts.length" class="muted">Контекста пока нет.</p>
        <p class="small muted">
          Удалённый материал больше не добавляется в новые запуски. Уже начатая задача, результаты и
          резервные копии могут сохранять ранее полученные данные.
        </p>
      </section>
    </div>
  </div>
</template>
<style scoped>
.workspace {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
}
input[type='file'] {
  max-width: 100%;
}
@media (max-width: 900px) {
  .workspace {
    grid-template-columns: 1fr;
  }
}
</style>
