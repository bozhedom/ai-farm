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
  wait: 'Подождать от 100 до 5000 мс. Обычно не нужно: после navigate, click, back и Enter машина сама ждёт загрузку. Только если страница на снимке явно ещё грузится.',
  finish:
    'Завершить задание и отдать отчёт владельцу: что найдено, какие источники, что требует человека. Вызови, когда цель достигнута или budget.wrap_up true, и обязательно при budget.final_step true.',
  request_approval:
    'Запросить подтверждение владельца перед необратимым или внешним действием: оплата, пароль, регистрация, публикация, сообщение человеку, принятие условий, перевод средств. Передай причину и само действие.',
  note_opportunity:
    'Записать найденную возможность заработка и свою оценку: название, адрес, суть, вид, нужен ли человек; decision: take (беру сам: текстовая работа, которую можно сделать и сдать на площадке), human (нужен владелец) или skip; fit 0-100 (насколько подходит); ai_forbidden true, если в тексте задания запрещены ИИ, нейросети или ChatGPT (такие задания сервер пропускает); estimated_value в минимальных единицах валюты (копейки, центы) с кодом валюты или null; reason - короткое объяснение. Это запись для владельца, а не доход.',
  draft_proposal:
    'Сохранить отклик на задание фриланс-площадки (сначала запиши задание через note_opportunity с decision take). Текст 200-3000 знаков, от первого лица, естественно, от имени владельца аккаунта, без упоминания ИИ, без контактов, ссылок, выдуманных дипломов, отзывов, портфолио и лет опыта, без оплаты вне площадки. price_amount - цена в минимальных единицах валюты или null. Сервер проверяет текст, дневной лимит и выдаёт разрешение на одну отправку: после этого вставь текст в поле через type_stored и нажми кнопку отправки площадки один раз.',
  type_stored:
    'Вставить сохранённый текст (отклик или документ этого задания по id) в поле, которое сейчас в фокусе. Переводы строк вставляются как переводы строк, форма не отправляется.',
  write_document:
    'Заказать у сервера текст результата по принятому заданию: название, подробное техзадание (brief, не меньше 20 знаков, с требованиями заказчика, объёмом, языком и стилем) и вид. Сервер делает отдельный платный вызов модели, сохраняет документ и в следующем шаге покажет его id и начало текста. Затем вставь его через type_stored.',
  prepare_send:
    'Получить разрешение на одну отправку на площадке: purpose delivery - сдать результат заказчику, reply - ответить заказчику по делу. Действует 15 минут и на одно нажатие кнопки отправки. Деньги вне площадки, контакты и вопрос «используете ли вы ИИ» - только через request_approval.',
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
