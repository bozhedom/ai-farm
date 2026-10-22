# AI Farm

Автономная ферма заработка с кабинетом владельца. Направления: спотовая торговля на OKX, Bybit, Binance и Bitget (Paper/Demo/Live), LLM-менеджер бумажных экспериментов, исполнение арбитража, фандинга, Aave и Kalshi, ферма идей с текстовыми услугами и витриной, «Компьютер ИИ» (GPT-6 Astra управляет браузером на отдельной машине и ищет законный заработок, в том числе на фриланс-площадках), учёт поступлений USDT на Bybit. Модели только возвращают проверенные данные; действия выполняет серверный код в жёстких пределах (`core/policy.ts`, транзакции БД). Live выключен по умолчанию; тестовые режимы не считаются выручкой.

**Продакшен:** https://farm.89.19.215.46.sslip.io/office (Timeweb Cloud, `89.19.215.46`). Текущее состояние — [docs/STATUS.md](docs/STATUS.md), правила разработки — [AGENTS.md](AGENTS.md).

## Стек

Nuxt 4 / Vue / TypeScript, PostgreSQL, отдельный Node worker, Docker Compose, Caddy, SearXNG. Модель — GPT-6 Astra через OpenRouter (локально можно бесплатные модели OpenRouter, Ollama или `MODEL_PROVIDER=demo`). Браузерный агент — `vm-agent/` (Playwright). Деньги — целые копейки, on-chain значения — строки wei / BigInt.

## Быстрый старт (локально)

Нужны Node.js 24 и Docker Compose.

```bash
npm ci
npm run setup                               # создаёт .env и каталоги, сохраняет существующие настройки
docker compose --profile app up -d --build
```

Откройте **http://localhost:3210/office**, пароль — `OWNER_PASSWORD` из `.env`. Торговле в Paper не нужны ни модель, ни ключи. Для разработки без Docker-приложения: `npm run dev` и `npm run worker` (БД из Compose). Подробности, провайдеры моделей и восстановление — [docs/03-setup.md](docs/03-setup.md).

Проверки перед коммитом:

```bash
npm run typecheck
npm test
npm run test:integration   # отдельная БД с суффиксом _test
npm run build
npm run format:check
npm run test:e2e:office    # Playwright, для изменённого интерфейса
```

## Документация

| Документ                                                      | О чём                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [STATUS.md](docs/STATUS.md)                                   | что развёрнуто, что работает по-настоящему, открытая приёмка и риски    |
| [01-project-plan.md](docs/01-project-plan.md)                 | объём, разрешения владельца и границы системы                           |
| [03-setup.md](docs/03-setup.md)                               | локальная установка, провайдеры, эксплуатация, копии и восстановление   |
| [06-project-map.md](docs/06-project-map.md)                   | структура кода                                                          |
| [13-openrouter.md](docs/13-openrouter.md)                     | GPT-6 Astra через OpenRouter, бюджеты, `cloud:check`, бесплатные модели |
| [17-public-site.md](docs/17-public-site.md)                   | публичная витрина и заказы                                              |
| [18-crypto-payments.md](docs/18-crypto-payments.md)           | тестовая криптооплата заказов (Sepolia/sandbox)                         |
| [19-farm-cycle.md](docs/19-farm-cycle.md)                     | цикл фермы идей: разведчики, отчёты, клиенты                            |
| [20-evolution.md](docs/20-evolution.md)                       | отбор и эволюция агентов фермы                                          |
| [21-trading.md](docs/21-trading.md)                           | спотовая торговля, разведчик пар, риск, допуск к Live                   |
| [23-opportunity-research.md](docs/23-opportunity-research.md) | источники и границы мониторинга рынков                                  |
| [24-agent-services.md](docs/24-agent-services.md)             | API текстовых услуг и план x402                                         |
| [25-earning-workspace.md](docs/25-earning-workspace.md)       | кабинет направлений                                                     |
| [26-trading-manager.md](docs/26-trading-manager.md)           | LLM-менеджер Paper-экспериментов                                        |
| [29-execution.md](docs/29-execution.md)                       | исполнение арбитража, фандинга, DeFi, прогнозов (`core/execution`)      |
| [29-execution-aave.md](docs/29-execution-aave.md)             | локальный стенд Aave на Anvil                                           |
| [32-computer-use.md](docs/32-computer-use.md)                 | Компьютер ИИ: политика, фриланс-площадки, vm-agent                      |
| [33-autonomy.md](docs/33-autonomy.md)                         | автопилот worker, распределение бюджета, `autopilot:check`              |
| [34-launch-timeweb.md](docs/34-launch-timeweb.md)             | продакшен: развёртывание, обновление, откат, ключи Bybit, кошелёк       |
| [35-owner-actions.md](docs/35-owner-actions.md)               | что может сделать только владелец                                       |
| [36-payments-choice.md](docs/36-payments-choice.md)           | исследование: как ферме принимать оплату от клиентов                    |
| [37-accounts.md](docs/37-accounts.md)                         | какие аккаунты площадок завести для Компьютера ИИ                       |
| [prompts/master.md](prompts/master.md)                        | общие инструкции всех модельных ролей                                   |
