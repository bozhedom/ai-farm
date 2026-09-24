import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

if (existsSync('.env')) {
  console.log('.env уже существует; настройки сохранены.')
} else {
  const password = randomBytes(24).toString('base64url')
  const env = readFileSync('.env.example', 'utf8')
    .replaceAll('CHANGE_ME', randomBytes(24).toString('hex'))
    .replace('OWNER_PASSWORD=GENERATE_WITH_SETUP', `OWNER_PASSWORD=${password}`)
    .replace(
      'SESSION_SECRET=GENERATE_WITH_SETUP',
      `SESSION_SECRET=${randomBytes(48).toString('hex')}`,
    )
  writeFileSync('.env', env, { mode: 0o600 })
  console.log('.env создан с правами 0600. Пароль владельца — OWNER_PASSWORD в этом файле.')
}
