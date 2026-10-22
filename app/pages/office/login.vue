<script setup lang="ts">
import { officeApi } from '~/composables/office/actions'
import { errorMessage } from '~/composables/office/errors'

useHead({ title: 'Вход' })
const password = ref('')
const error = ref('')
const busy = ref(false)
const show = ref(false)
async function login() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await officeApi.login(password.value)
    await navigateTo('/office')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main class="login">
    <form class="login-card" @submit.prevent="login">
      <span class="login-brand"
        ><span class="brand-mark"><OfficeIcon name="leaf" /></span>AI Farm</span
      >
      <h1>Вход в кабинет</h1>
      <p class="muted">
        Всё о ферме в одном месте: заказы и клиенты, торговля на биржах, поиск работы, деньги и
        расходы.
      </p>
      <div class="field" :class="{ 'is-error': error }">
        <label for="password">Пароль</label>
        <div class="pass">
          <input
            id="password"
            v-model="password"
            class="input"
            :type="show ? 'text' : 'password'"
            autocomplete="current-password"
            required
            autofocus
            :aria-invalid="!!error"
            aria-describedby="login-error"
          />
          <button
            type="button"
            class="btn btn-icon btn-ghost btn-sm eye"
            :aria-label="show ? 'Скрыть пароль' : 'Показать пароль'"
            @click="show = !show"
          >
            <OfficeIcon :name="show ? 'eyeOff' : 'eye'" />
          </button>
        </div>
        <span v-if="error" id="login-error" class="hint" role="alert">{{ error }}</span>
      </div>
      <button class="btn btn-primary btn-lg btn-block" :disabled="busy || !password">
        {{ busy ? 'Входим' : 'Войти' }}
      </button>
      <a class="small back" href="/storefront">Открыть сайт</a>
    </form>
  </main>
</template>
<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--s-6) var(--gutter);
  background: var(--canvas);
}
.login-card {
  width: min(420px, 100%);
  padding: var(--s-8);
  display: grid;
  gap: var(--s-4);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font: 800 18px var(--font-display);
  color: var(--ink);
  margin-bottom: 12px;
}
.login-card h1 {
  font-size: var(--text-2xl);
}
.login-card h1 + p {
  margin-top: -8px;
}
.pass {
  position: relative;
}
.pass .input {
  padding-right: 48px;
}
.eye {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}
.back {
  justify-self: center;
}
@media (max-width: 639px) {
  .login-card {
    padding: var(--s-6);
  }
}
</style>
