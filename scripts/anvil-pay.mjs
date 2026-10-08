// Sends a test transfer from anvil's unlocked test account, for showing the payment without
// MetaMask. Works only against a local anvil node (chain 11155111); refuses anything else.
//   npm run anvil:pay -- <order link or token>
//   npm run anvil:pay -- <address> <amountWei>
// ANVIL_RPC_URL (default http://127.0.0.1:18545), APP_URL (default APP_ORIGIN or :3210).
const rpcUrl = process.env.ANVIL_RPC_URL || 'http://127.0.0.1:18545'
const appUrl = (process.env.APP_URL || process.env.APP_ORIGIN || 'http://127.0.0.1:3210').replace(
  /\/$/,
  '',
)
const args = process.argv.slice(2)

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function node(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).catch(() => fail(`Нет связи с узлом ${rpcUrl}. Запустите anvil.`))
  const body = await response.json()
  if (body.error) fail(`${method}: ${body.error.message}`)
  return body.result
}

let receiver, amountWei
if (args.length === 1) {
  const token = args[0].split('/').filter(Boolean).pop()
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail('Нужна ссылка заказа или токен из неё.')
  const response = await fetch(`${appUrl}/api/public/orders/${token}`).catch(() =>
    fail(`Сайт ${appUrl} не отвечает. Задайте APP_URL.`),
  )
  if (!response.ok) fail(`Заказ не найден на ${appUrl} (${response.status}).`)
  const order = await response.json()
  if (order.payment?.mode !== 'sepolia') fail('Этот заказ оплачивается не криптой.')
  if (order.payment.network !== 'local')
    fail(
      'Заказ ждёт перевод в публичной Sepolia. anvil его не оплатит, нужен кошелёк с тестовым ETH.',
    )
  if (!order.payment.canSubmit) fail('Заказ сейчас не ждёт оплату.')
  receiver = order.payment.receiver
  amountWei = order.payment.amountWei
} else if (args.length === 2) {
  ;[receiver, amountWei] = args
} else {
  fail('Использование: npm run anvil:pay -- <ссылка заказа | адрес сумма_в_wei>')
}
if (!/^0x[0-9a-fA-F]{40}$/.test(receiver))
  fail('Адрес должен быть 0x и 40 шестнадцатеричных знаков.')
if (!/^[1-9]\d{0,77}$/.test(amountWei)) fail('Сумма должна быть целым числом wei.')

if ((await node('eth_chainId')) !== '0xaa36a7') fail('Узел не в сети 11155111.')
const client = String(await node('web3_clientVersion'))
if (!/anvil/i.test(client)) fail(`Это не локальный anvil (${client}). Перевод не отправлен.`)
const [from] = await node('eth_accounts')
const hash = await node('eth_sendTransaction', [
  { from, to: receiver, value: '0x' + BigInt(amountWei).toString(16) },
])
console.log(`Перевод отправлен в локальной тестовой сети anvil.`)
console.log(`Сумма: ${amountWei} wei на ${receiver}`)
console.log(`Транзакция: ${hash}`)
console.log('Сайт найдёт перевод сам за несколько секунд, вводить номер транзакции не нужно.')
