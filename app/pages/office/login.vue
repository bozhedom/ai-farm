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
    await navigateTo('/office/trading')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main class="login">
    <form class="card card-raised login-card" @submit.prevent="login">
      <span class="brand-mark big"><OfficeIcon name="leaf" /></span>
      <h1>Вход в кабинет</h1>
      <p class="muted">Торговая ферма. Контроль капитала и стратегий.</p>
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
      <a class="small back" href="/storefront">Сохранённая витрина текстов</a>
    </form>
  </main>
</template>
<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--s-6) var(--gutter);
  background:
    radial-gradient(circle at 20% 15%, var(--brand-soft), transparent 40%),
    radial-gradient(circle at 85% 90%, var(--sun-soft), transparent 45%), var(--canvas);
}
.login-card {
  width: min(400px, 100%);
  padding: var(--s-8);
  display: grid;
  gap: var(--s-4);
}
.brand-mark.big {
  width: 48px;
  height: 48px;
  border-radius: 14px;
}
.brand-mark.big :deep(svg) {
  width: 26px;
  height: 26px;
  stroke: #fff;
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
