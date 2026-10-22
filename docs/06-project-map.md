# Карта проекта

Начинайте с [STATUS.md](STATUS.md): там текущее состояние и незавершённая приёмка. Запуск и восстановление — [03-setup.md](03-setup.md), продакшен — [34-launch-timeweb.md](34-launch-timeweb.md), границы системы — [01-project-plan.md](01-project-plan.md), правила — [AGENTS.md](../AGENTS.md).

## Процессы

- **web** — Nuxt 4 (страницы `app/`, API `server/`), порт 3210.
- **worker** — `worker/index.ts`: независимые циклы с пульсом (`core/worker-loops.ts`), очередь заданий (`core/worker-runtime.ts`, `core/queue.ts`), автопилот (`core/autopilot.ts`).
- **PostgreSQL** — единственное хранилище; миграции `db/NNN-*.sql` применяет `npm run db:migrate`.
- **observer**, **backup** — минутная проверка готовности (`scripts/observe.ts`) и ежесуточный `pg_dump` (`scripts/backup-loop.sh`).
- **SearXNG** (`deploy/searxng.yml`), **Caddy** (`compose.edge.yaml`, HTTPS на сервере).
- **vm-agent** — отдельный сервис браузера для Компьютера ИИ (см. ниже).

## Интерфейс

- Публичный сайт ([17-public-site.md](17-public-site.md)): `app/pages/storefront.vue` (витрина, также `/`), `services/[slug].vue`, `order/[token].vue`, `terms.vue`; блоки `app/components/public/`, помощники `app/utils/public-site.ts`.
- Кабинет: `app/pages/office.vue` — общая оболочка (меню, нижние вкладки на телефоне, статус связи). Разделы `app/pages/office/`: `index` (обзор «Как ферма зарабатывает», данные `core/income/`), `launch` (чек-лист «Запуск», `core/launch/`), `trading` (биржи), `manager`, `earnings` (направления и `core/execution`), `computer` (Компьютер ИИ), `money` (расходы, оплата USDT), `farm` и `ideas/` (ферма идей), `agents`, `products`, `orders/`, `leads`, `settings`, `login`.
- `app/components/{office,trading,manager,earnings,public}/` — блоки разделов; `app/composables/office/` — загрузка по типам `core/contracts/*`, опрос раз в 5 секунд, действия владельца.
- `app/middleware/legacy.global.ts` и `routeRules` в `nuxt.config.ts` — редиректы со старых адресов.
- `app/assets/tokens.css`, `components.css` — токены и компоненты; светлая/тёмная тема по системной настройке, публичный сайт всегда светлый.

## Ядро (`core/`)

- **Общее:** `config.ts` (env), `db.ts`, `auth.ts`, `policy.ts` (жёсткие пределы и схемы), `budget.ts` (атомарные денежные резервы), `pacing.ts` (распределение платного дневного бюджета по часам UTC), `queue.ts`, `activity.ts`, `operations.ts`, `observation.ts`, `rate-limit.ts`, `stand.ts` (демо-стенд).
- **Автономность** ([33-autonomy.md](33-autonomy.md)): `autopilot.ts` (запуск Paper/Demo-циклов, менеджера и Paper-направлений; не снимает стопы и не трогает Live), `worker-loops.ts` (пульс каждого цикла), `autonomy.ts` (расписание), `research-window.ts` (28-дневное окно исследований).
- **Модели** ([13-openrouter.md](13-openrouter.md)): `providers/index.ts` (общий вызов, учёт `tool_calls`), `openai.ts` + `openrouter-paid.ts` (GPT-6 Astra через OpenRouter), `openrouter-tools.ts` (единственный путь с инструментами, для Компьютера ИИ), `openrouter.ts` (бесплатные модели), `local.ts` (Ollama, SearXNG), `demo.ts`, `rejection.ts`, `json-schema.ts`. Общие инструкции ролей — `prompts/master.md`.
- **Ферма идей** ([19-farm-cycle.md](19-farm-cycle.md), [20-evolution.md](20-evolution.md)): `taxonomy.ts`, `ideas.ts`, `agents.ts`, `evolution.ts`, `jobs/{scout,report,lead,evolve,research,fulfill,generate-text}.ts`, `research-campaign.ts`, `opportunities.ts`, `customer-discovery.ts`, `activity-feed.ts`, `office.ts`.
- **Услуги и заказы** ([17-public-site.md](17-public-site.md), [18-crypto-payments.md](18-crypto-payments.md), [24-agent-services.md](24-agent-services.md)): `service-catalog.ts`, `templates.ts`, `structured-text.ts`, `storefront.ts`, `public-catalog.ts`, `public-orders.ts`, `orders.ts`, `order-progress.ts`, `order-resolution.ts`, `payments.ts` (только sandbox/Sepolia), `products.ts`, `services/` (API услуг).
- **Спотовая торговля** ([21-trading.md](21-trading.md)): `trading/` — адаптеры `okx|bybit|binance|bitget.ts`, `engine.ts`, `scout.ts`/`universe.ts`/`rotation.ts` (разведчик пар), `strategy.ts`/`classic.ts` (стратегии, grid/DCA), `accounting.ts`/`decimal.ts` (точный учёт), `store.ts`.
- **LLM-менеджер** ([26-trading-manager.md](26-trading-manager.md)): `manager/` — снимок, план, задачи, лимиты `MANAGER_POLICY`.
- **Направления** ([25-earning-workspace.md](25-earning-workspace.md), [23-opportunity-research.md](23-opportunity-research.md)): `earnings/` (мониторинг без исполнения), `opportunities/`.
- **Исполнение** ([29-execution.md](29-execution.md), [29-execution-aave.md](29-execution-aave.md)): `execution/` — `drivers/{arbitrage,funding,defi,prediction}.ts`, `adapters/{spot,bybit-funding,aave,kalshi,paper}.ts`, отдельные счета и журналы.
- **Компьютер ИИ** ([32-computer-use.md](32-computer-use.md)): `computer-use/` — `schema.ts`/`tools.ts` (действия, zod), `policy.ts` (проверка до обращения к ВМ), `runtime.ts` (цикл задания), `client.ts` (HTTP к vm-agent), `platforms.ts`, `profile.ts`, `directions.ts`, `goals.ts`, `manual.ts` (управление вручную), `words.ts`, `view.ts`.
- **Кошелёк** ([34-launch-timeweb.md](34-launch-timeweb.md#кошелёк-bybit-только-чтение), [36-payments-choice.md](36-payments-choice.md)): `wallet/` — ключ Bybit только на чтение, синхронизация депозитов USDT, отметки «доход / не доход».
- **Доход и запуск:** `income/` (обзор: реальные деньги отдельно от тестовых, статус бирж), `launch/` (шаги чек-листа по таблицам и env).
- `contracts/` — общие типы API web ↔ кабинет.

## Сервер

- `server/api/` — маршруты: `public/`, `orders/`, `office/`, `trading/`, `execution/`, `earnings/`, `computer-use/`, `services/`, `opportunities/`, `auth/`, `health`, `readiness`.
- `server/middleware/` и `server/utils/` — сессия, Origin, лимиты, обработка ошибок.

## Браузерный агент (`vm-agent/`)

Отдельный Node-сервис с Playwright/Chromium (`src/server.ts`, `browser.ts`, `actions.ts`, `guard.ts`, `proxy.ts` — прокси с закреплением проверенного публичного адреса). Запускается `compose.vm.yaml` на отдельной машине или в отдельном контейнере и сети; ферма обращается к нему по `VM_AGENT_URL` с токеном. Ключей, кошельков и доступа к БД у него нет.

## Инфраструктура и скрипты

- `compose.yaml` — основной стек; `compose.local.yaml` (Ollama, SearXNG локально), `compose.edge.yaml` (Caddy с корневым `Caddyfile`), `compose.prebuilt.yaml` (готовый образ `FARM_IMAGE` без сборки), `compose.cloud.yaml` (облачная модель + SearXNG, без контейнера инференса), `compose.anvil.yaml` (локальный блокчейн для тестов), `compose.demo.yaml` + `deploy/demo/` (демо-стенд).
- `deploy/timeweb/` — продакшен: `netcheck.sh`, `bootstrap.sh`, `deploy.sh`, `update.sh`, `restore-from-dump.sh`, `db-snapshot.sh`, `status.sh`, `dc.sh`, `lib.sh` ([34-launch-timeweb.md](34-launch-timeweb.md)). Продакшен запускается набором `compose.yaml` + `compose.prebuilt.yaml` + `compose.cloud.yaml` + `compose.edge.yaml` (см. `deploy/timeweb/lib.sh`). `deploy/cloud/Caddyfile` относится к прежнему серверу и не используется.
- `scripts/` — `setup.mjs`, `migrate.ts`, `backup.sh`, `restore-check.sh`, проверки `trading-check.ts`, `cloud-check.ts`, `wallet-check.ts`, `server-autopilot-check.ts`, локальные запуски `autopilot-local.ts`, `execution-local.ts`, `execution-aave-local.ts`, `check-quality.ts`, разовые SQL (`reclassify-rejected-calls.sql`).
- `.github/workflows/` — CI.

## Тесты

- `tests/unit/` — чистые правила и адаптеры (`npm test`).
- `tests/integration/` — транзакции и сквозные сценарии на отдельной БД с суффиксом `_test` (`npm run test:integration`).
- `tests/e2e/` — Playwright кабинета с подменой API (`npm run test:e2e:office`).
- `npm run test:crypto` — проверки на Anvil (платежи Sepolia, Aave).

Локальные `.env`, `.secrets/`, `.health/`, `backups/` и `output/` исключены из Git. Рабочую БД нельзя использовать для интеграционных тестов. Перед коммитом: `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`, `npm run format:check`; изменённый интерфейс — в Playwright.
