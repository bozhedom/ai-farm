<script setup lang="ts">
const { state, failure, refresh } = useFarm()
const route = useRoute()
const menu = [
  ['/', 'Обзор'],
  ['/?view=directions', 'Направления'],
  ['/catalog', 'Услуги'],
  ['/?view=opportunities', 'Клиенты'],
  ['/?view=hypotheses', 'Исследования'],
  ['/?view=orders', 'Заказы'],
  ['/?view=guide', 'Как пользоваться'],
]
const secondary = [
  ['/?view=settings', 'Настройки'],
  ['/?view=audit', 'Журнал'],
]
const active = (url: string) => {
  if (url === '/') return route.path === '/' && !route.query.view
  if (url === '/catalog') return route.path === '/catalog'
  const view = url.split('view=')[1]
  return (
    (route.path === '/' && route.query.view === view) ||
    (view === 'orders' && route.path.startsWith('/orders/'))
  )
}
const logoutError = ref('')
const loggingOut = ref(false)
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 2000)
})
onUnmounted(() => clearInterval(timer))
async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  logoutError.value = ''
  try {
    await $fetch('/api/auth/logout', { method: 'POST', body: {} })
    state.value = null
    await navigateTo('/login')
  } catch {
    logoutError.value = 'Не удалось выйти. Проверьте соединение и повторите.'
  } finally {
    loggingOut.value = false
  }
}
const workerOk = computed(() => !failure.value && state.value?.autonomy.workerAlive)
const modelLabel = computed(() =>
  state.value?.config.modelProvider === 'ollama'
    ? 'Бесплатная локальная модель'
    : state.value?.config.modelProvider === 'openrouter'
      ? 'OpenRouter · бесплатные модели'
      : state.value?.config.modelProvider === 'demo'
        ? 'Демонстрация'
        : state.value?.config.model || 'Загрузка…',
)
</script>
<template>
  <div class="workspace">
    <a class="skip-link" href="#main-content">К содержимому</a>
    <aside class="sidebar">
      <NuxtLink to="/" class="brand"
        ><span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span
        ><span>AI Farm<small>Текстовые сервисы</small></span></NuxtLink
      >
      <nav class="primary-nav" aria-label="Главное меню">
        <NuxtLink
          v-for="([url, label], i) in menu"
          :key="url"
          :to="url!"
          :class="{ active: active(url!) }"
          :aria-current="active(url!) ? 'page' : undefined"
          ><svg
            viewBox="0 0 24 24"
            width="19"
            height="19"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <path v-if="i === 0" d="M3 10 12 3l9 7v10H3Z M9 20v-7h6v7" />
            <path v-else-if="i === 1" d="M12 3v18M3 12h18M5 5l14 14M5 19 19 5" />
            <path v-else-if="i === 2" d="M4 4h6v6H4Z M14 4h6v6h-6Z M4 14h6v6H4Z M14 14h6v6h-6Z" />
            <path
              v-else-if="i === 3"
              d="M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3"
            />
            <path v-else-if="i === 4" d="M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0" />
            <path v-else-if="i === 5" d="M5 3h14v18H5Z M8 8h8 M8 12h8 M8 16h5" />
            <path v-else d="M12 21V5M12 5Q7 2 3 4v15q4-2 9 2 5-4 9-2V4q-4-2-9 1" /></svg
          >{{ label }}</NuxtLink
        >
      </nav>
      <nav class="secondary-nav" aria-label="Управление">
        <NuxtLink
          v-for="[url, label] in secondary"
          :key="url"
          :to="url!"
          :class="{ active: active(url!) }"
          :aria-current="active(url!) ? 'page' : undefined"
          >{{ label }}</NuxtLink
        ><button class="quiet" :disabled="loggingOut" @click="logout">
          {{ loggingOut ? 'Выходим…' : 'Выйти' }}
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="worker-state">
          <span class="dot" :class="workerOk ? 'green' : 'amber'" />{{
            workerOk ? 'Обработчик на связи' : 'Нет связи с обработчиком'
          }}
        </div>
        <p>Закрытый тестовый сервис.<br />Реальные платежи не подключены.</p>
      </div>
    </aside>
    <div class="main-wrap">
      <header class="topbar">
        <span>Кабинет владельца</span><span class="mode-badge">{{ modelLabel }}</span>
      </header>
      <main id="main-content" class="main-content">
        <div v-if="failure" class="notice error" role="alert">{{ failure }}</div>
        <div v-if="logoutError" class="notice error" role="alert">{{ logoutError }}</div>
        <slot />
      </main>
      <footer><span>AI Farm</span><span>Тестовые заказы не приносят выручку</span></footer>
    </div>
  </div>
</template>
