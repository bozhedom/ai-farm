import { describe, expect, it } from 'vitest'
import { splitActions, withoutCodes } from '../../app/composables/office/launch'

describe('launch step wording for the owner', () => {
  it('moves server settings to the administrator and keeps them in the details', () => {
    const { owner, admin } = splitActions([
      'В Bybit, раздел API, создайте ключ с типом Read-Only.',
      'Админ вписывает BYBIT_WALLET_READ_API_KEY и BYBIT_WALLET_READ_SECRET в .env и перезапускает worker.',
    ])
    expect(owner.map((a) => a.text)).toEqual([
      'В Bybit, раздел API, создайте ключ с типом Read-Only.',
    ])
    expect(admin).toHaveLength(1)
    expect(admin[0]!.text).toBe('Ключ только для чтения вносит администратор на сервере.')
    expect(admin[0]!.text).not.toMatch(/[A-Z]{3,}_|\.env/)
    expect(admin[0]!.tech).toContain('BYBIT_WALLET_READ_API_KEY')
  })

  it('drops bracketed server codes from a state sentence', () => {
    expect(withoutCodes('Ключ есть, но модель сейчас недоступна (OPENROUTER_HTTP_400).')).toBe(
      'Ключ есть, но модель сейчас недоступна.',
    )
    expect(withoutCodes('На сервере выключено: COMPUTER_USE_ENABLED=false в .env.')).toBe(
      'На сервере выключено (настройка сервера).',
    )
    expect(withoutCodes('Нельзя. Не хватает: TRADING_LIVE_ENABLED=true в .env, ключа.')).toBe(
      'Нельзя. Не хватает: разрешения администратора на сервере, ключа.',
    )
  })
})
