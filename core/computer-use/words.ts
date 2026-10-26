/**
 * Owner words for the computer-use codes. Shared by the office pages and the server-side launch
 * checklist, so one explanation is written once; the codes themselves stay in the technical log.
 */
export const computerReasons: Record<string, string> = {
  COMPUTER_USE_DISABLED_ON_SERVER: 'На сервере выключено: COMPUTER_USE_ENABLED=false в .env.',
  COMPUTER_USE_PROVIDER_UNSUPPORTED:
    'Нужна платная модель через OpenRouter: MODEL_PROVIDER=openai и OPENAI_TRANSPORT=openrouter.',
  COMPUTER_USE_VM_NOT_CONFIGURED: 'Не настроена виртуальная машина: VM_AGENT_URL и VM_AGENT_TOKEN.',
  COMPUTER_USE_SYSTEM_PAUSED: 'Ферма на паузе или остановлена. Снять можно в настройках.',
  COMPUTER_USE_WORKER_UNAVAILABLE:
    'Связь с worker потеряна. Работа продолжится после восстановления.',
  COMPUTER_USE_FAILURES:
    'Три задания подряд не завершились. Проверьте машину и модель, затем включите заново.',
  COMPUTER_USE_DAILY_LIMIT:
    'Дневной лимит расходов на браузер исчерпан. Продолжим после полуночи UTC.',
  COMPUTER_USE_DAILY_PACING:
    'Дневной бюджет распределяется по суткам UTC: следующее задание ротации начнётся позже. Ваши задания идут без ожидания.',
  COMPUTER_USE_TASK_CAP:
    'Достигнут лимит расходов на одно задание: работа завершается с отчётом сервера.',
  COMPUTER_USE_STEP_LIMIT: 'Достигнут лимит шагов задания: работа завершается с отчётом сервера.',
  COMPUTER_USE_LIMIT_EMPTY:
    'Задание дошло до лимита, ничего не записав: считается неудачей подряд.',
  COMPUTER_USE_MODEL_INVALID: 'Модель трижды ответила не по формату. Задание остановлено.',
  COMPUTER_USE_VM_UNAVAILABLE: 'Виртуальная машина не отвечает.',
  COMPUTER_USE_SESSION_LOST: 'Сессия браузера на машине потеряна.',
  COMPUTER_USE_SCREENSHOT_INVALID: 'Машина вернула неверный снимок экрана.',
  COMPUTER_USE_VM_RESPONSE_INVALID: 'Машина ответила в неверном формате.',
  COMPUTER_USE_PAUSED: 'Работа выключена владельцем.',
  COMPUTER_USE_CANCELLED: 'Отменено владельцем.',
  COMPUTER_USE_STEP_FAILED: 'Шаг не удался по неизвестной причине.',
  COMPUTER_USE_TOOL_CALL_INVALID: 'Ответ модели не прошёл проверку формата.',
  COMPUTER_USE_PRIVATE_NETWORK: 'Внутренние адреса сети закрыты.',
  COMPUTER_USE_HOST_BLOCKED: 'Сайт из запретного списка: обход проверок не делаем.',
  COMPUTER_USE_SCHEME_BLOCKED:
    'Запрещённая схема: обход проверок, мультиаккаунты или чужие данные.',
  COMPUTER_USE_URL_SCHEME: 'Допустимы только адреса http и https.',
  COMPUTER_USE_PAYMENT_SITE: 'Платёжный сервис или биржа: только с вашего разрешения.',
  COMPUTER_USE_CREDENTIALS: 'Ввод пароля: только с вашего разрешения.',
  COMPUTER_USE_SENSITIVE_FIELD: 'Поле с картой, кодом или документом: только с вашего разрешения.',
  COMPUTER_USE_PAYMENT_DATA: 'Похоже на номер карты или кошелька: только с вашего разрешения.',
  COMPUTER_USE_OUTWARD_ACTION: 'Публикация, регистрация, отправка или оплата: нужно ваше решение.',
  COMPUTER_USE_OUTWARD_PAGE: 'Страница оформления или входа: нужно ваше решение.',
  COMPUTER_USE_MODEL_REQUESTED: 'Модель сама попросила подтверждение.',
  COMPUTER_USE_OWNER_APPROVED: 'Выполнено с вашего разрешения.',
  COMPUTER_USE_OWNER_REJECTED: 'Вы отклонили это действие.',
  COMPUTER_USE_APPROVAL_EXPIRED: 'Запрос ждал сутки без ответа и закрыт.',
  COMPUTER_USE_SCREENSHOT_REQUIRED:
    'Клик без снимка экрана отклонён: снимок пришёл на следующем шаге.',
  COMPUTER_USE_LOOP_URL: 'Этот адрес уже открывали дважды в задании: третий переход отклонён.',
  COMPUTER_USE_OPPORTUNITY_LIMIT: 'В этом задании уже записано достаточно возможностей.',
  COMPUTER_USE_QUEUE_FULL: 'Очередь заданий заполнена. Дождитесь выполнения.',
  COMPUTER_USE_GOAL_LENGTH: 'Опишите задание от 10 до 1000 символов без угловых скобок.',
  COMPUTER_USE_TASK_FINISHED: 'Задание уже завершено.',
  COMPUTER_TASK_NOT_FOUND: 'Такого задания нет.',
  COMPUTER_APPROVAL_NOT_FOUND: 'Этот запрос уже решён.',
  POLICY_IDEA_TOPIC_BLOCKED: 'Такие темы ферма не берёт.',
  PROVIDER_CHANGED_DURING_JOB: 'Сменился провайдер модели: начатое задание закрыто.',
  BUDGET_BLOCKED: 'Не хватает дневного или месячного бюджета для резерва задания.',
  OPENAI_BUDGET_BLOCKED: 'Общий лимит платной модели исчерпан.',
  UNCERTAIN_CALL_REQUIRES_REVIEW: 'Исход вызова модели неясен: расход сохранён, повтор запрещён.',
  TARGET_BLOCKED: 'Машина отказала в переходе: закрытый адрес.',
  NAVIGATION_TIMEOUT: 'Страница не загрузилась вовремя.',
  ACTION_FAILED: 'Браузер не смог выполнить действие.',
  COMPUTER_USE_MANUAL_CONTROL: 'Вы управляете браузером: шаги модели приостановлены.',
  COMPUTER_USE_MANUAL_NOT_ACTIVE: 'Управление вручную не включено или истекло.',
  COMPUTER_USE_AI_FORBIDDEN: 'В задании запрещён ИИ: такие задания пропускаем.',
  COMPUTER_USE_AI_DENIAL: 'Текст отрицает использование ИИ: так писать нельзя.',
  COMPUTER_USE_OFF_PLATFORM_PAYMENT: 'Оплата мимо площадки запрещена: за это банят аккаунт.',
  COMPUTER_USE_CONTACT_DETAILS: 'Контакты вне площадки в тексте запрещены.',
  COMPUTER_USE_EXTERNAL_LINK: 'Внешние ссылки в отклике запрещены.',
  COMPUTER_USE_UNVERIFIED_CLAIM: 'Дипломы, отзывы, портфолио и годы опыта выдумывать нельзя.',
  COMPUTER_USE_PLATFORM_UNKNOWN: 'Это не фриланс-площадка из списка.',
  COMPUTER_USE_PLATFORM_MISMATCH: 'Адрес задания не относится к указанной площадке.',
  COMPUTER_USE_PLATFORM_NOT_LOGGED_IN: 'На этой площадке не отмечен вход под вашим аккаунтом.',
  COMPUTER_USE_AUTO_PROPOSALS_OFF:
    'Автоотклики выключены: включите переключатель и COMPUTER_USE_AUTO_PROPOSALS.',
  COMPUTER_USE_OPPORTUNITY_REQUIRED:
    'Сначала задание нужно записать и оценить через note_opportunity.',
  COMPUTER_USE_DECISION_NOT_TAKE: 'Модель сама решила не брать это задание.',
  COMPUTER_USE_PROPOSAL_LIMIT: 'Дневной лимит откликов на этой площадке исчерпан.',
  COMPUTER_USE_SEND_LIMIT: 'Дневной лимит отправок на этой площадке исчерпан.',
  COMPUTER_USE_PERMIT_GRANTED: 'Выдано разрешение на одну отправку (15 минут).',
  COMPUTER_USE_SEND_PERMIT: 'Отправлено по разрешению на одну отправку.',
  COMPUTER_USE_STORED_NOT_FOUND: 'Такого текста в этом задании нет.',
  COMPUTER_USE_PRICE_BELOW_MINIMUM: 'Цена ниже вашей минимальной из профиля исполнителя.',
  COMPUTER_USE_PRICE_CURRENCY_REQUIRED:
    'В отклике нет цены в валюте, для которой в профиле задан минимум.',
  COMPUTER_USE_NO_DIRECTIONS:
    'Нет ни одного включённого направления поиска и ни одной площадки с входом: ротации нечего делать.',
  COMPUTER_USE_DIRECTION_NOT_FOUND: 'Такого направления нет.',
  COMPUTER_USE_DIRECTION_BUILT_IN: 'Встроенное направление можно выключить, но не удалить.',
  COMPUTER_USE_DIRECTIONS_LIMIT: 'Направлений уже достаточно: удалите или выключите лишние.',
  COMPUTER_USE_DIRECTION_TITLE: 'Название направления: от 3 до 80 символов без угловых скобок.',
  COMPUTER_USE_DIRECTION_WEIGHT: 'Приоритет направления: целое число от 1 до 5.',
  COMPUTER_USE_DOCUMENT_LIMIT: 'В этом задании уже подготовлено достаточно документов.',
  COMPUTER_USE_LOGIN_NOT_FOUND: 'Для этой площадки не сохранён вход.',
  COMPUTER_USE_LOGIN_UNREADABLE:
    'Сохранённый вход не расшифровывается (сменился ключ сервера). Введите логин и пароль заново.',
  COMPUTER_USE_LOGIN_URL_INVALID:
    'Адрес страницы входа: полная ссылка https:// на сайт площадки или её страницу входа.',
  COMPUTER_USE_LOGIN_HOST_MISMATCH:
    'Логин и пароль вводятся только на https-странице самой площадки, а открыт другой сайт.',
  COMPUTER_USE_LOGIN_LIMIT:
    'Попыток входа на эту площадку сегодня уже достаточно: проверьте логин и пароль, чтобы аккаунт не заблокировали.',
  LOGIN_HOST_MISMATCH:
    'Логин и пароль вводятся только на https-странице самой площадки, а открыт другой сайт.',
  LOGIN_FORM_NOT_FOUND: 'На странице не найдена форма входа с полями логина и пароля.',
}
export function computerReason(code: string | null | undefined) {
  const value = String(code ?? '').trim()
  if (!value) return ''
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(value)) return value
  if (computerReasons[value]) return computerReasons[value]!
  if (/_HTTP_\d+$/.test(value)) return 'Служба ответила ошибкой. Подробности в техжурнале.'
  return 'Служебная причина, подробности в техжурнале.'
}
