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

function parametersOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown> & {
    properties?: Record<string, unknown>
    required?: string[]
  }
  delete json.$schema
  if (json.properties) delete json.properties.name
  json.required = (json.required || []).filter((key) => key !== 'name')
  return json
}

/** Function tools for one computer-use step; the list is fixed by the server. */
export const computerUseTools: readonly ToolDefinition[] = Object.freeze(
  toolCallSchema.options.map((option) => ({
    name: option.shape.name.value,
    description: descriptions[option.shape.name.value]!,
    parameters: parametersOf(option),
  })),
)
