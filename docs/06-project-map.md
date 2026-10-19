# Карта проекта

Начинайте с [STATUS.md](STATUS.md): там текущий результат и незавершённая приёмка. Для запуска и восстановления — [03-setup.md](03-setup.md), для границ системы — [01-project-plan.md](01-project-plan.md).

## Интерфейс

- Публичный сайт без пароля ([17-public-site.md](17-public-site.md)): `app/pages/index.vue` (витрина), `services/[slug].vue` (услуга и форма), `order/[token].vue` (заказ по секретной ссылке, оплата, результат), `terms.vue`; блоки в `app/components/public/`, помощники браузера в `app/utils/public-site.ts`.
- `core/public-orders.ts` — секретные ссылки, сумма счёта, вид заказа для покупателя; `core/rate-limit.ts` — лимиты публичного API; `server/utils/client.ts` — адрес покупателя для лимитов. Оплата криптой и сканер блоков — [18-crypto-payments.md](18-crypto-payments.md).
- `app/pages/office.vue` — общая оболочка кабинета (`OfficeShell`): меню, шторка и нижние вкладки на телефоне, живой статус, состояние «нет связи».
- `app/pages/office/` — разделы кабинета: `index` (Обзор «Как ферма зарабатывает», данные `/api/office/income` из `core/income/`), `farm` (прежняя главная: ферма идей), `ideas/` (рейтинг, карточка идеи, отчёты руководителя), `agents`, `products`, `orders/`, `leads` (Клиенты), `money`, `settings` (режим, расписание, отбор, состояние сервера, техжурнал), `login`.
- `app/components/office/` — общие блоки кабинета: лента, бейджи, балл, пустые состояния, режим работы, факты идеи, история версий продукта.
- `app/composables/office/` — загрузка по типам `core/contracts/office.ts` (`data.ts`), общий опрос раз в 5 секунд с паузой в скрытой вкладке (`resource.ts`), действия владельца (`actions.ts`), подписи и форматирование.
- `app/middleware/legacy.global.ts` и `routeRules` в `nuxt.config.ts` — 301 со старых `/login`, `/catalog`, `/orders/*`, `/?view=`, `/office?view=` в разделы кабинета.
- `app/assets/` — `tokens.css` (токены) и `components.css` (компоненты под классом `ds` на `<html>`).
- `tests/e2e/office.spec.ts` — `npm run test:e2e:office`: все разделы на 1440 и 390 px с подменой `/api/office/**` типизированными данными из `tests/e2e/fixtures/office.ts`; снимки в `output/playwright/stream-c/`.

## Сервер и фоновые задания

- `server/api/` — HTTP-маршруты; `server/middleware/` и `server/utils/` — защита запросов и обработка ввода / ошибок.
- `worker/index.ts` — расписание и независимые циклы исследований, заказов и сверки платежей.
- `core/jobs/run.ts` — выбор обработчика и привязка вызовов к заданию.
- `core/jobs/research.ts` — исследование, критик, сборка, контрольный пример и сохранение версии продукта.
- `core/jobs/fulfill.ts` — исполнение оплаченного заказа и отдельная проверка результата.
- `core/source-posts.ts` и `core/jobs/generate-text.ts` — полный исходник в каждом из трёх локальных оформлений; рецепт определяется сохранённым обещанием услуги.
- `core/providers/openrouter.ts` — облачные бесплатные модели, строгая схема и проверка нулевой стоимости; [подключение](13-openrouter.md).
- `core/structured-text.ts` — схемы полей восьми услуг и серверная сборка заголовков, списков, шагов; прежние сохранённые ответы `{text}` читаются без новой генерации.
- `core/customer-discovery.ts` — отбор поисковых фрагментов по теме и признакам публичной задачи; актуальность проверяет владелец.
- `core/jobs/text-context.ts` — контекст генерации и проверки: факты заказчика отделены от описания сервиса в каталоге.
- `core/providers/index.ts` — общий вызов моделей / поиска, схемы ответов и учёт расходов.
- `core/providers/local.ts` — Ollama и SearXNG; `core/providers/demo.ts` — явно обозначенные демонстрационные данные.
- `core/queue.ts` — постоянная очередь, ручной запуск, аренда, повторы и восстановление.
- `core/research-campaign.ts` — полный последовательный обход направлений, идемпотентный запуск, отмена оставшихся шагов и прогресс. Очередь переносит ещё не начатые платные направления на следующий день только при доказанном исчерпании дневного бюджета.
- `core/opportunities.ts` — поисковые кандидаты, дедупликация, защита от устаревшего повторного результата, ручные статусы и постраничный список. Статус договорённости не влияет на деньги.
- `core/autonomy.ts` — суточные / недельные слоты, переключатель расписания и причины ожидания; `core/products.ts` — постраничная история версий.
- `core/policy.ts` — разрешённые шаблоны, схемы данных и ограничения; `core/budget.ts` — атомарные денежные резервы.
- `core/service-catalog.ts` — единый каталог 12 услуг: аудитории, форматы, контрольные материалы, запросы исследований и потенциальных клиентов. `core/templates.ts` создаёт из него серверные рецепты. Один рецепт используется при исследовании, контрольной сборке и исполнении заказа.
- `core/orders.ts`, `core/payments.ts`, `core/evolution.ts` — заказы, тестовые платежи и оценка стратегий.
- `core/order-resolution.ts` — явное закрытие проблемного тестового заказа без выдачи или возврата; причина, платежи и расходы сохраняются.
- `core/order-progress.ts` — причины ожидания и остановки заказа; `core/payments.ts` сохраняет историю хешей и доказательство проверки, блокирует параллельные / устаревшие ответы.
- `core/operations.ts`, `core/observation.ts` — готовность служб и расчёт непрерывных 48 часов по сохранённым измерениям; `scripts/observe.ts` — независимый минутный наблюдатель без ключей и модели.
- `core/config.ts`, `core/db.ts`, `core/auth.ts`, `core/activity.ts` — конфигурация, БД, сессии и наблюдение за вызовами.
- `prompts/master.md` — общие инструкции всех модельных ролей. Разрешения и действия контролирует сервер.
- Ферма ([19-farm-cycle.md](19-farm-cycle.md), [20-evolution.md](20-evolution.md)): `core/taxonomy.ts` (отрасли, темы, поисковые фразы), `core/ideas.ts` (отпечаток, повторы, балл, статусы), `core/agents.ts` (параметры, имена «Разведчик А2», метрики), `core/evolution.ts` (балл и раунд отбора), `core/jobs/{scout,report,lead,evolve}.ts`, расписание в `core/autonomy.ts`, лента в `core/activity-feed.ts`, данные кабинета в `core/office.ts` и `server/api/office/**`, подготовка показа `scripts/demo-prepare.ts`.

- `core/storefront.ts` — серверный список цен (`priceList`, `priceIds`), цены типов услуг по умолчанию, `publicSlug`, `publicServiceProjection`, рубли и wei без плавающей точки.
- `core/contracts/` — общие типы API: `common.ts`, `public.ts` (покупатель), `office.ts` (кабинет).

## Данные, инфраструктура и проверки

- `db/` — последовательные SQL-миграции. История, снимки заказов и версии продуктов сохраняются.
- `scripts/` — настройка, миграции, копии, проверка восстановления и тестовый кошелёк.
- `scripts/check-quality.ts` и `scripts/fixtures/quality.ts` — 12 независимых синтетических контрольных материалов для Ollama или бесплатного OpenRouter, только в отдельной БД `_test`. Переменные `QUALITY_PROVIDER` и `QUALITY_TEMPLATE` позволяют выбрать бесплатного провайдера и один тип; отчёт сохраняется в `output/quality/`.
- `compose.yaml`, `compose.local.yaml`, `compose.edge.yaml` — основной стек, локальные провайдеры и HTTPS на VPS.
- `deploy/` — настройки внешних служб; `.github/workflows/` — CI.
- `tests/unit/` — чистые правила и адаптеры; `tests/integration/` — транзакции и сквозные сценарии на отдельной БД с суффиксом `_test`.
- `docs/reports/` — протоколы фактических прогонов, включая отказы.

Локальные `.env`, `.secrets/`, `.health/`, `backups/` и `output/` исключены из Git. Рабочую БД нельзя использовать для интеграционных тестов.

Для изменения приложения обязательны `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`, `npm run format:check`. Изменённый интерфейс проверяется в Playwright. Подробности — в [AGENTS.md](../AGENTS.md).

## Срезы A и B, поток C и владение файлами

Общий фундамент (миграция `014`, `core/config.ts`, `core/storefront.ts`, `core/contracts/*`, помощники `tests/integration/helpers/db.ts`) лежит в main. После него эти файлы не меняют; новые поля контрактов добавляются только по согласованию. Оплата только тестовая: sandbox или Sepolia.

| Поток                | Worktree и БД              | Владеет                                                                                                                                                                                                                                                                                                                                                                                                  | Не трогает                                                                                                                                 |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A, публичный путь    | `wt-public`, `farm_a_test` | `db/015-*`, `core/orders.ts`, `core/public-orders.ts`, `core/public-catalog.ts`, `core/order-progress.ts`, `core/payments.ts`, `core/rate-limit.ts`, `server/middleware/security.ts`, `server/api/public/**`, `server/api/orders/**`, страницы `app/pages/{index,services,order,pay,terms}`                                                                                                              | `core/queue.ts`, `core/budget.ts`, `core/policy.ts`, `core/jobs/**`, `worker/`, `prompts/master.md`, `server/api/office/**`                |
| B, ферма             | `wt-farm`, `farm_b_test`   | `db/017-020`, `core/taxonomy.ts`, `core/ideas.ts`, `core/agents.ts`, `core/evolution.ts`, `core/jobs/**`, `core/policy.ts`, `core/queue.ts`, `core/autonomy.ts`, `core/budget.ts`, `core/opportunities.ts`, `core/activity-feed.ts`, `core/providers/**`, `worker/`, `prompts/master.md`, `server/api/{dashboard,control}*`, `server/api/office/**`, `server/api/opportunities/**`, `scripts/migrate.ts` | `core/orders.ts`, `core/payments*.ts`, `core/public-*.ts`, `server/middleware/security.ts`, `server/api/public/**`, `server/api/orders/**` |
| C, фронтенд кабинета | своя ветка                 | `app/pages/office/**`, `app/components/**`, `app/composables/**`, `app/middleware/legacy.global.ts` (цели редиректов на `/office/agents`, `/office/ideas`, `/office/leads`)                                                                                                                                                                                                                              | серверный код, миграции, контракты                                                                                                         |

Срезы добавляют только новые файлы тестов (`tests/unit/*`, `tests/integration/*`); `tests/integration/system.test.ts` меняет только B и только там, где этого требует очередь. Порядок слияния любой.
