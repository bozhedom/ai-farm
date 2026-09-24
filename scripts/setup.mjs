import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

mkdirSync('backups', { recursive: true, mode: 0o700 })

if (existsSync('.env')) {
  console.log('.env уже существует; настройки сохранены.')
} else {
  const password = randomBytes(24).toString('base64url')
  const env = readFileSync('.env.example', 'utf8')
    .replace('LOCAL_UID=1000', `LOCAL_UID=${process.getuid?.() ?? 1000}`)
    .replace('LOCAL_GID=1000', `LOCAL_GID=${process.getgid?.() ?? 1000}`)
    .replaceAll('CHANGE_ME', randomBytes(24).toString('hex'))
    .replace('OWNER_PASSWORD=GENERATE_WITH_SETUP', `OWNER_PASSWORD=${password}`)
    .replace(
      'SESSION_SECRET=GENERATE_WITH_SETUP',
      `SESSION_SECRET=${randomBytes(48).toString('hex')}`,
    )
  writeFileSync('.env', env, { mode: 0o600 })
  console.log('.env создан с правами 0600. Пароль владельца — OWNER_PASSWORD в этом файле.')
}
