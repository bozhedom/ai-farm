<script setup lang="ts">
import {
  assistantSections,
  type AssistantReply,
  type AssistantSection,
} from '../../../core/contracts/assistant'
import { officeFetch } from '~/composables/office/resource'
import { describeError } from '~/composables/office/errors'
import { when } from '~/composables/office/format'
type Message = { role: 'user' | 'assistant'; text: string; reply?: AssistantReply }
const history = useState<Message[]>('office-assistant-history', () => [])
// Logout and expired sessions clear Nuxt state before the mounted dialog is removed.
const messages = computed({
  get: () => history.value ?? [],
  set: (value: Message[]) => (history.value = value),
})
const route = useRoute()
const section = computed(
  () =>
    assistantSections.find((s) => route.path === s.path)?.id ??
    assistantSections.find((s) => s.path !== '/office' && route.path.startsWith(`${s.path}/`))
      ?.id ??
    'overview',
)
const sectionTitle = computed(() => assistantSections.find((s) => s.id === section.value)!.title)
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLTextAreaElement>()
const transcript = ref<HTMLElement>()
const question = ref('')
const busy = ref(false)
let controller: AbortController | undefined
onBeforeUnmount(() => controller?.abort())
const error = ref('')
const retry = ref<{
  requestId: string
  question: string
  section: AssistantSection
  history: { role: 'user' | 'assistant'; text: string }[]
} | null>(null)
function open() {
  dialog.value?.showModal()
  nextTick(() => input.value?.focus())
}
async function scroll(reply = false) {
  await nextTick()
  const area = transcript.value
  if (!area) return
  const last = reply
    ? [...area.querySelectorAll<HTMLElement>('.assistant-message.assistant')].at(-1)
    : undefined
  area.scrollTop = last
    ? area.scrollTop + last.getBoundingClientRect().top - area.getBoundingClientRect().top - 8
    : area.scrollHeight
}
async function send(repeat = false) {
  if (busy.value || (!repeat && !question.value.trim())) return
  const request = repeat
    ? retry.value
    : {
        requestId: crypto.randomUUID(),
        question: question.value.trim(),
        section: section.value,
        history: messages.value
          .slice(-6)
          .map((m) => ({ role: m.role, text: m.text.slice(0, 1500) })),
      }
  if (!request) return
  if (!repeat) {
    messages.value.push({ role: 'user', text: request.question })
    question.value = ''
  }
  retry.value = request
  busy.value = true
  controller = new AbortController()
  error.value = ''
  await scroll()
  try {
    const reply = await officeFetch<AssistantReply>('/api/office/assistant', {
      method: 'POST',
      body: request,
      timeout: 135000,
      signal: controller.signal,
    })
    messages.value.push({ role: 'assistant', text: reply.text, reply })
    if (messages.value.length > 30) messages.value.splice(0, messages.value.length - 30)
    retry.value = null
  } catch (e) {
    error.value = describeError(e).text
  } finally {
    busy.value = false
    await scroll(!error.value)
  }
}
function clear() {
  messages.value = []
  retry.value = null
  error.value = ''
}
function links(reply: AssistantReply) {
  return assistantSections.filter((s) => reply.sections.includes(s.id))
}
function hint(text: string) {
  question.value = text
  input.value?.focus()
}
</script>
<template>
  <button
    class="btn btn-primary assistant-launch"
    aria-haspopup="dialog"
    aria-controls="office-assistant"
    @click="open"
  >
    <OfficeIcon name="spark" />Помощник
  </button>
  <dialog
    id="office-assistant"
    ref="dialog"
    class="assistant-dialog"
    aria-labelledby="assistant-title"
    @click="
      (e) => {
        if (e.target === dialog) dialog?.close()
      }
    "
  >
    <div class="assistant-panel">
      <header class="assistant-header">
        <div>
          <h2 id="assistant-title">Помощник по системе</h2>
          <p class="small muted">Сейчас открыт раздел «{{ sectionTitle }}»</p>
        </div>
        <button class="btn btn-icon btn-sm" aria-label="Закрыть помощника" @click="dialog?.close()">
          <OfficeIcon name="close" />
        </button>
      </header>
      <div
        ref="transcript"
        class="assistant-messages"
        role="log"
        aria-label="Переписка с помощником"
        aria-live="polite"
        :aria-busy="busy"
      >
        <div v-if="!messages.length" class="assistant-welcome stack-sm">
          <p>
            Помогу разобраться в настройках и объясню текущее состояние. Могу подсказать, куда
            перейти.
          </p>
          <button
            v-for="text in [
              'Как работает этот раздел?',
              'Где оставить только криптоторговлю?',
              'Что сейчас происходит?',
            ]"
            :key="text"
            class="btn"
            @click="hint(text)"
          >
            {{ text }}
          </button>
        </div>
        <article
          v-for="(message, index) in messages"
          :key="index"
          class="assistant-message"
          :class="message.role"
        >
          <strong class="small">{{
            message.role === 'user'
              ? 'Вы'
              : message.reply?.source === 'model'
                ? 'ИИ-помощник'
                : message.reply?.source === 'demo'
                  ? 'Демонстрационная справка'
                  : 'Справка без ИИ'
          }}</strong>
          <p class="assistant-text">{{ message.text }}</p>
          <template v-if="message.reply">
            <p v-if="message.reply.reason" class="small muted">
              ИИ-ответ недоступен: {{ describeError({ statusMessage: message.reply.reason }).text }}
            </p>
            <nav class="assistant-links" aria-label="Разделы из ответа">
              <NuxtLink
                v-for="link in links(message.reply)"
                :key="link.id"
                :to="link.path"
                @click="dialog?.close()"
                >{{ link.title }}</NuxtLink
              >
            </nav>
            <small class="muted">Снимок состояния: {{ when(message.reply.at) }}</small>
          </template>
        </article>
        <p v-if="busy" class="small muted" role="status">Проверяю состояние и готовлю ответ…</p>
      </div>
      <form class="assistant-form stack-sm" @submit.prevent="send()">
        <div v-if="error" class="note note-wait" role="alert">
          {{ error }}
          <button
            v-if="retry"
            type="button"
            class="btn btn-sm"
            :disabled="busy"
            @click="send(true)"
          >
            Проверить ответ повторно
          </button>
        </div>
        <label for="assistant-question" class="small">Ваш вопрос</label>
        <textarea
          id="assistant-question"
          ref="input"
          v-model="question"
          class="textarea"
          rows="3"
          maxlength="2000"
          required
          placeholder="Например: почему менеджер не запускает эксперименты?"
        />
        <div class="assistant-controls">
          <button class="btn btn-primary" :disabled="busy || !question.trim()">
            {{ busy ? 'Готовлю ответ…' : 'Отправить вопрос' }}</button
          ><button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy || !messages.length"
            @click="clear"
          >
            Очистить чат
          </button>
        </div>
        <p class="small muted">
          Помощник объясняет работу и показывает состояние. Настройки и сделки он не меняет.
        </p>
        <details class="assistant-privacy small muted">
          <summary>О данных и расходах</summary>
          <p>
            Вопрос, последние сообщения и сводка состояния передаются модели в пределах общего
            бюджета. Не отправляйте секреты. При недоступной модели показывается справка без ИИ.
          </p>
        </details>
      </form>
    </div>
  </dialog>
</template>
<style scoped>
.assistant-launch {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 40;
  box-shadow: var(--shadow-lg);
}
.assistant-dialog {
  position: fixed;
  inset: auto 20px 20px auto;
  padding: 0;
  margin: 0;
  width: min(520px, calc(100vw - 40px));
  max-width: none;
  height: min(780px, calc(100dvh - 40px));
  max-height: none;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  color: var(--ink);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.assistant-dialog::backdrop {
  background: rgb(23 26 33 / 30%);
}
.assistant-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.assistant-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px;
  border-bottom: 1px solid var(--line);
}
.assistant-header h2 {
  font-size: 20px;
}
.assistant-header p {
  margin-top: 5px;
}
.assistant-messages {
  flex: 1;
  min-height: 100px;
  overflow: auto;
  padding: 20px;
  overscroll-behavior: contain;
}
.assistant-message {
  margin-bottom: 18px;
  padding: 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.assistant-message.user {
  background: var(--canvas-deep);
  margin-left: 30px;
}
.assistant-text {
  white-space: pre-wrap;
  margin: 8px 0;
}
.assistant-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 12px 0;
  font-size: var(--text-sm);
}
.assistant-form {
  padding: 16px 20px;
  border-top: 1px solid var(--line);
}
.assistant-form .textarea {
  min-height: 80px;
  max-height: 160px;
}
.assistant-form > label {
  display: block;
  font-weight: 600;
}
.assistant-privacy summary {
  cursor: pointer;
}
.assistant-privacy p {
  margin-top: 8px;
}
.assistant-panel .btn {
  white-space: normal;
  padding-top: 8px;
  padding-bottom: 8px;
}
.assistant-welcome {
  display: grid;
  gap: 12px;
}
.assistant-welcome > * + * {
  margin-top: 0;
}
.assistant-welcome > p {
  margin-bottom: 8px;
}
.assistant-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}
.assistant-form > p {
  font-size: 11px;
  line-height: 1.45;
}
.assistant-welcome > button {
  text-align: left;
  justify-content: flex-start;
}
@media (max-width: 1023px) {
  .assistant-launch {
    right: 16px;
    bottom: calc(84px + env(safe-area-inset-bottom));
  }
}
@media (max-width: 600px) {
  .assistant-dialog {
    inset: 0;
    width: 100%;
    height: 100dvh;
    border-radius: 0;
    border: 0;
  }
  .assistant-form {
    padding-bottom: max(16px, env(safe-area-inset-bottom));
  }
  .assistant-form > p {
    max-height: 64px;
    overflow: auto;
  }
}
</style>
