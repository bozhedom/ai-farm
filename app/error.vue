<script setup lang="ts">
import type { NuxtError } from '#app'

// Russian error page for unknown addresses and failed pages, on the public site frame.
const props = defineProps<{ error: NuxtError }>()
const notFound = computed(() => props.error.statusCode === 404)
const route = useRoute()
const office = computed(() => route.path.startsWith('/office'))
useHead({
  title: () => (notFound.value ? 'Страница не найдена. AI Farm' : 'Ошибка. AI Farm'),
  meta: [{ name: 'robots', content: 'noindex' }],
})
const target = computed(() => (office.value ? '/office' : '/'))
const leave = () => clearError({ redirect: target.value })
</script>

<template>
  <PublicShell>
    <div class="container">
      <div class="error-page">
        <div class="empty">
          <h3>{{ notFound ? 'Такой страницы нет' : 'Что-то пошло не так' }}</h3>
          <p>
            {{
              notFound
                ? 'Возможно, ссылка устарела или в ней опечатка.'
                : 'Страница не открылась. Попробуйте ещё раз через минуту.'
            }}
          </p>
          <button type="button" class="btn btn-primary" @click="leave">
            {{ office ? 'В кабинет' : 'На главную' }}
          </button>
        </div>
      </div>
    </div>
  </PublicShell>
</template>

<style scoped>
.error-page {
  padding: var(--s-16) 0;
}
</style>
