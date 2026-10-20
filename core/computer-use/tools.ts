import { z } from 'zod'
import type { ToolDefinition } from '../providers/openrouter-tools'
import { toolCallSchema } from './schema'

const descriptions: Record<string, string> = {
  navigate: 'Открыть адрес http(s) в текущей вкладке. Внутренние и служебные адреса запрещены.',
  click: 'Кликнуть по точке экрана (x, y) в пикселях снимка 1280x800.',
  type: 'Набрать текст в поле, которое сейчас в фокусе. Пароли и данные карт не вводи.',
  key: 'Нажать одну клавишу: Enter, Tab, Escape, стрелки, PageDown и другие из списка.',
  scroll: 'Прокрутить страницу в точке (x, y) на deltaY пикселей (плюс вниз, минус вверх).',
  back: 'Вернуться на предыдущую страницу.',
  wait: 'Подождать загрузку страницы, от 100 до 5000 мс.',
  finish:
    'Завершить задание и отдать отчёт владельцу: что найдено, какие источники, что требует человека.',
  request_approval:
    'Запросить подтверждение владельца перед необратимым или внешним действием: оплата, пароль, регистрация, публикация, сообщение человеку, принятие условий, перевод средств. Передай причину и само действие.',
  note_opportunity:
    'Записать найденную легальную возможность заработка: название, адрес страницы, суть, вид и нужен ли человек. Это запись для владельца, а не доход.',
}

/**
 * OpenAI strict function schemas reject `oneOf` and Unicode property escapes in `pattern`
 * (HTTP 400, checked against GPT-6 Astra on 20.10.2026). The model gets `anyOf` and no patterns;
 * the server still validates every call with the full zod schema.
 */
export function strictCompatible(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictCompatible)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'pattern') continue
    out[key === 'oneOf' ? 'anyOf' : key] = strictCompatible(inner)
  }
  return out
}

function parametersOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown> & {
    properties?: Record<string, unknown>
    required?: string[]
  }
  delete json.$schema
  if (json.properties) delete json.properties.name
  json.required = (json.required || []).filter((key) => key !== 'name')
  return strictCompatible(json) as Record<string, unknown>
}

/** Function tools for one computer-use step; the list is fixed by the server. */
export const computerUseTools: readonly ToolDefinition[] = Object.freeze(
  toolCallSchema.options.map((option) => ({
    name: option.shape.name.value,
    description: descriptions[option.shape.name.value]!,
    parameters: parametersOf(option),
  })),
)
