/**
 * Owner wording for launch steps. The checklist on the server names settings and keys
 * precisely, which helps the administrator but not the owner. Here each action is split into
 * what the owner does and what the administrator does on the server; the exact server wording
 * stays available in a disclosure.
 */

/** A server setting name, a file or a service name that means nothing to the owner. */
const technical =
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*\*?|\.env\b|\bworker\b|\bweb и worker\b|vm-agent|docs\/[\w./-]+/

/** Plain sentence for an administrator action, by what it configures. First match wins. */
const adminPlain: [RegExp, string][] = [
  [/OPENROUTER|MODEL_PROVIDER/, 'Администратор вносит ключ OpenRouter на сервере.'],
  [/BUDGET/, 'Изменить пределы расходов может только администратор на сервере.'],
  [/AUTOPILOT_ON_BOOT/, 'Администратор включает автопилот при запуске сервера.'],
  [/AUTONOMY_ENABLED/, 'Администратор разрешает ферме работать по расписанию.'],
  [/VM_AGENT|vm-agent/, 'Администратор ставит программу на машину и подключает её к ферме.'],
  [/COMPUTER_USE_AUTO_PROPOSALS/, 'Администратор разрешает автоотклики на сервере.'],
  [/PAYMENT_USDT/, 'Передайте адрес администратору: он вносит его на сервере.'],
  [/WALLET_READ/, 'Ключ только для чтения вносит администратор на сервере.'],
  [
    /PUBLIC_SELLER|PUBLIC_CONTACT|PUBLIC_TERMS/,
    'Администратор указывает продавца и условия на сайте.',
  ],
  [/DEMO_API_KEY|DEMO_SECRET/, 'Тестовый ключ вносит администратор на сервере.'],
  [/LIVE_API_KEY|LIVE_SECRET/, 'Ключ вносит администратор на сервере.'],
  [/TRADING_LIVE_ENABLED/, 'Администратор включает реальную торговлю на сервере.'],
  [/FUNDING_|PREDICTION_|DEFI_/, 'Тестовые ключи направлений вносит администратор на сервере.'],
  [/[Пп]ерезапуст/, 'Администратор перезапускает ферму.'],
]

/** The owner's share of a mixed action; the administrator's share goes to the other list. */
const ownerPart: [RegExp, string][] = [
  [/^Арендуйте/, 'Арендуйте отдельную виртуальную машину для браузера ИИ.'],
  [/^Проверьте пределы/, 'Проверьте пределы расходов в разделе «Деньги».'],
  [
    /строка «Подключения» станет зелёной/,
    'После перезапуска в «Настройках» строка «Подключения» станет зелёной.',
  ],
]

/** Old section names that the checklist may still use. */
const renamed: [RegExp, string][] = [
  [/«Торговой ферме»/g, 'разделе «Мои биржи»'],
  [/«Торговая ферма»/g, '«Мои биржи»'],
]

export const ownerWords = (text: string) =>
  renamed.reduce((out, [from, to]) => out.replace(from, to), text)

const setting = String.raw`[A-Z][A-Z0-9]*_[A-Z0-9_]+`

/**
 * Drops server codes from a state sentence: a code in brackets such as «(OPENROUTER_HTTP_400)»
 * and setting names such as «COMPUTER_USE_ENABLED=false в .env».
 */
export const withoutCodes = (text: string) =>
  ownerWords(
    text
      .replace(new RegExp(String.raw`\s*\((?:${setting}(?:,\s*)?)+\)`, 'g'), '')
      .replace(new RegExp(String.raw`:\s*${setting}=false в \.env`, 'g'), ' (настройка сервера)')
      .replace(
        new RegExp(String.raw`${setting}=true в \.env`, 'g'),
        'разрешения администратора на сервере',
      )
      .replace(new RegExp(String.raw`\s*${setting}`, 'g'), ''),
  )

export type LaunchAction = { text: string; tech?: string }

export function splitActions(actions: string[]) {
  const owner: LaunchAction[] = []
  const admin: LaunchAction[] = []
  for (const action of actions) {
    const isAdmin = /^Админ/.test(action) || technical.test(action)
    if (!isAdmin) {
      owner.push({ text: ownerWords(action) })
      continue
    }
    const ownerShare = ownerPart.find(([pattern]) => pattern.test(action))?.[1]
    if (ownerShare) owner.push({ text: ownerShare })
    const plain = adminPlain.find(([pattern]) => pattern.test(action))?.[1]
    const text = plain ?? 'Администратор делает это на сервере.'
    // Two server actions that say the same in plain words become one line with both details.
    const same = admin.find((a) => a.text === text)
    if (same) same.tech = `${same.tech} ${action}`
    else admin.push({ text, tech: action })
  }
  return { owner, admin }
}

export const linkWords = (link: string | null, label: string) =>
  link?.startsWith('/office/trading') ? 'Мои биржи' : ownerWords(label)
