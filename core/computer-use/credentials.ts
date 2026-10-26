import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config'
import { audit, query, type Connection } from '../db'
import { hostOf, isPrivateHost } from './policy'
import { isFreelancePlatform } from './platforms'

/**
 * Platform logins the owner stores for computer use. The owner enters them in the office; they
 * are encrypted at rest and decrypted only to build one `fill_login` VM action. The model never
 * sees them: it calls `log_in` with a platform domain, the server checks the page host and the
 * daily attempt limit, and the VM fills the fields on that platform's https page only. Audit rows
 * and step records hold the domain, never the values.
 */

const VERSION = 'v1'
function key() {
  return Buffer.from(
    hkdfSync('sha256', config().SESSION_SECRET, 'ai-farm', 'computer-use-credentials-v1', 32),
  )
}
/** AES-256-GCM with the domain as associated data: a value moved to another row fails to open. */
export function sealCredential(value: string, domain: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(domain))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
}
export function openCredential(sealed: string, domain: string) {
  const [version, data] = sealed.split(':', 2)
  if (version !== VERSION || !data) throw new Error('COMPUTER_USE_LOGIN_UNREADABLE')
  try {
    const raw = Buffer.from(data, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(domain))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    // SESSION_SECRET changed or the row was altered: the owner enters the login again.
    throw new Error('COMPUTER_USE_LOGIN_UNREADABLE')
  }
}

const value = z
  .string()
  .min(1)
  .max(200)
  .refine((text) => !/\p{Cc}/u.test(text), 'CONTROL_CHARACTERS')
export const credentialInputSchema = z
  .object({
    domain: z.string().trim().toLowerCase().min(3).max(100),
    username: value,
    password: value,
    loginUrl: z.string().trim().max(2000).default(''),
  })
  .strict()
export type CredentialInput = z.input<typeof credentialInputSchema>

/**
 * Hosts where the login of `domain` may be filled: the platform and its subdomains, plus the host
 * of the owner's login page when it is elsewhere (freelance.habr.com signs in on account.habr.com).
 */
export function loginHosts(domain: string, loginUrl: string) {
  const extra = loginUrl ? hostOf(loginUrl).replace(/^www\./, '') : ''
  return [...new Set([domain, ...(extra ? [extra] : [])])]
}
export function loginHostMatches(url: string, hosts: readonly string[]) {
  if (!/^https:\/\//i.test(url)) return false
  const host = hostOf(url)
  return !!host && hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

function checkLoginUrl(url: string) {
  if (!url) return ''
  if (!/^https:\/\//i.test(url) || !URL.canParse(url)) return 'COMPUTER_USE_LOGIN_URL_INVALID'
  const host = hostOf(url)
  if (!host || isPrivateHost(host) || !host.includes('.')) return 'COMPUTER_USE_LOGIN_URL_INVALID'
  return ''
}

export async function saveCredentials(input: CredentialInput) {
  const data = credentialInputSchema.parse(input)
  if (!isFreelancePlatform(data.domain)) throw new Error('COMPUTER_USE_PLATFORM_UNKNOWN')
  const urlError = checkLoginUrl(data.loginUrl)
  if (urlError) throw new Error(urlError)
  await query(
    `INSERT INTO computer_use_credentials(domain,username_enc,password_enc,login_url) VALUES($1,$2,$3,$4)
     ON CONFLICT (domain) DO UPDATE SET username_enc=EXCLUDED.username_enc,password_enc=EXCLUDED.password_enc,
       login_url=EXCLUDED.login_url,last_login_error='',updated_at=now()`,
    [
      data.domain,
      sealCredential(data.username, data.domain),
      sealCredential(data.password, data.domain),
      data.loginUrl,
    ],
  )
  await audit(
    'computer_use_credentials',
    'Владелец сохранил вход на площадку для модели. Логин и пароль зашифрованы, модель их не видит.',
    { domain: data.domain, loginUrl: !!data.loginUrl },
  )
  return data.domain
}

/** The owner's login page of a platform with a stored login; throws without one. */
export async function storedLoginUrl(domain: string) {
  const [row] = await query('SELECT login_url FROM computer_use_credentials WHERE domain=$1', [
    domain.trim().toLowerCase(),
  ])
  if (!row) throw new Error('COMPUTER_USE_LOGIN_NOT_FOUND')
  return row.login_url as string
}

/** The owner's "log in now" task: open the login page, let the server fill it, report. */
export function loginGoal(domain: string, loginUrl: string) {
  const start = loginUrl || `https://${domain}/`
  return `Войди на ${domain} под аккаунтом владельца. Открой ${start}, найди форму входа и вызови log_in с platform_domain ${domain}: логин и пароль введёт сервер. Если вход в два шага, вызови log_in и на втором. Убедись по экрану, что вход выполнен (видно имя аккаунта или личный кабинет), и заверши задание через finish с коротким отчётом. Если площадка просит код из SMS или почты, капчу или подтверждение, вызови request_approval с действием wait и напиши, что нужно владельцу.`
}

export async function deleteCredentials(domain: string) {
  const name = domain.trim().toLowerCase()
  const removed = await query(
    'DELETE FROM computer_use_credentials WHERE domain=$1 RETURNING domain',
    [name],
  )
  if (!removed.length) throw new Error('COMPUTER_USE_LOGIN_NOT_FOUND')
  await audit('computer_use_credentials', 'Владелец удалил сохранённый вход на площадку.', {
    domain: name,
    deleted: true,
  })
}

/** Platforms the model may log in itself; the values stay on the server. */
export async function credentialDomains(db?: Connection) {
  const rows = await query<{ domain: string }>(
    'SELECT domain FROM computer_use_credentials ORDER BY domain',
    [],
    db,
  )
  return rows.map((row) => row.domain).filter(isFreelancePlatform)
}

/** Decrypted login of one platform for a single `fill_login` action; null without one. */
export async function readCredentials(domain: string, db?: Connection) {
  const [row] = await query(
    'SELECT username_enc,password_enc,login_url FROM computer_use_credentials WHERE domain=$1',
    [domain],
    db,
  )
  if (!row) return null
  return {
    username: openCredential(row.username_enc as string, domain),
    password: openCredential(row.password_enc as string, domain),
    loginUrl: row.login_url as string,
  }
}

export async function recordLoginAttempt(domain: string, error: string) {
  await query(
    'UPDATE computer_use_credentials SET last_login_at=now(),last_login_error=$2 WHERE domain=$1',
    [domain, error.slice(0, 200)],
  )
}
