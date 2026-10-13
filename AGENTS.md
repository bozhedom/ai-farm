# Project instructions

Отвечай по-русски, кратко и по делу. Обычные обратимые действия выполняй самостоятельно.

## Architecture

- Nuxt 4 / Vue / TypeScript, PostgreSQL, separate Node worker, Docker Compose.
- Read `docs/01-project-plan.md`, `docs/03-setup.md` and `docs/STATUS.md` before continuing significant work.
- Models produce validated data. Only server code performs actions. Never grant models shell, SQL, secrets, policy editing, wallets or unrestricted network access.
- `prompts/master.md` is shared by every model role. Hard limits belong in `core/policy.ts` and database transactions, not only in prompts.
- Sandbox and Sepolia are test modes. Never count test payments as revenue. Mainnet and real cryptocurrency sales are intentionally unavailable.
- The owner authorized a separate multi-exchange spot-trading product (OKX, Bybit, Binance, Bitget) on 12.10.2026. Ledgers, agents, orders and risk history are isolated by exchange and paper/demo/live mode. The owner clarified that 100 USDT was an example, not a funding ceiling: initial live allocations are owner-defined, remain immutable after activation and must pass exact-input, minimum-capital and exchange-balance checks. The owner also authorized local-only dynamic discovery and rotation of eligible USDT spot pairs through a bounded, deterministic market scout; fixed BTC/ETH allowlists are no longer the trading scope. Only server code can submit cash IOC orders admitted by the current scout and execution checks; models never get keys or trading tools. Live trading needs local credentials, explicit enablement and the enforced acceptance gates. Transfers, withdrawals, margin and derivatives remain unavailable. See `docs/21-trading.md`.
- Money uses integer kopecks; on-chain values use integer wei strings / BigInt. No floating point accounting.
- The owner authorized local development of additional earning directions on 13.10.2026. Grid/DCA are paper-only. Public funding, prediction, DeFi and cross-exchange observations have no execution authority. The service API reuses test orders and owner authentication; it is not x402 or a production payment rail. See `docs/25-earning-workspace.md` for readiness and customer prerequisites.
- The owner authorized a local LLM trading manager on 13.10.2026. It proposes bounded Paper experiments through validated data and a durable task queue; server code applies and evaluates them. It cannot start trading, clear stops, edit policy/capital, operate Demo/Live or execute arbitrary tasks. Manager costs share the existing ledger and global budgets with additional limits in `MANAGER_POLICY`. See `docs/26-trading-manager.md`.
- On 13.10.2026 the owner explicitly authorized publishing the market scout, earning workspace, manager and handover documents to the existing VPS. This supersedes the earlier local-only deployment restriction for these features. Preserve server credentials, trading allocations, risk history, existing stops and paid-model limits; publishing does not authorize Live or clearing the existing model-work emergency stop. See `docs/10-cloud-vps.md`.
- Preserve archived strategies, product snapshots, obligations, audit records and idempotency keys.
- Never weaken tests, security or operating limits to make a demo pass.

## Verification and handover

- `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build` for meaningful application changes. Integration tests need a separate database ending in `_test`.
- `npm run format:check` for formatting. Check changed UI with Playwright.
- Keep `docs/STATUS.md` honest about real external integrations and uncompleted acceptance checks.
- Commit complete, verified work in small independent commits. English conventional commit messages, no model attribution or bot coauthors. Check commit author and message before finishing.
- Never commit `.env`, credentials, private keys, database dumps or customer material. Credentials are configured locally / on the server, not sent through chat.
