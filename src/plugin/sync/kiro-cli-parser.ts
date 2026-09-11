import { createHash } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export function getCliDbPath(): string {
  const override = process.env.KIROCLI_DB_PATH
  if (override) return override
  const p = platform()
  if (p === 'win32')
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'kiro-cli',
      'data.sqlite3'
    )
  if (p === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  return join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3')
}

export function safeJsonParse(value: unknown): any | null {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function normalizeExpiresAt(input: unknown): number {
  if (typeof input === 'number') {
    return input < 10_000_000_000 ? input * 1000 : input
  }
  if (typeof input === 'string' && input.trim()) {
    const t = new Date(input).getTime()
    if (!Number.isNaN(t) && t > 0) return t
    const n = Number(input)
    if (Number.isFinite(n) && n > 0) return normalizeExpiresAt(n)
  }
  return 0
}

export function findClientCredsRecursive(input: unknown): {
  clientId?: string
  clientSecret?: string
} {
  const root = input as any
  if (!root || typeof root !== 'object') return {}

  const stack: any[] = [root]
  const visited = new Set<any>()
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (visited.has(cur)) continue
    visited.add(cur)

    const clientId = cur.client_id || cur.clientId
    const clientSecret = cur.client_secret || cur.clientSecret
    if (typeof clientId === 'string' && typeof clientSecret === 'string') {
      if (clientId && clientSecret) return { clientId, clientSecret }
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v)
      continue
    }
    for (const v of Object.values(cur)) stack.push(v)
  }
  return {}
}

export function makePlaceholderEmail(
  authMethod: string,
  region: string,
  clientId?: string,
  profileArn?: string
): string {
  // Mirror createDeterministicAccountId: an IDC clientId is re-issued on every
  // re-auth, so it is not part of the identity. Including it here put it back
  // in through the back door — the account id is derived from this email, so
  // every sign-in whose usage lookup could not supply a real address minted a
  // brand new account row. One user reached eight rows for a single account,
  // which also switched on the multi-account request queue that is meant for
  // people who really do have several.
  const seed =
    authMethod === 'idc'
      ? `${authMethod}:${region}:${profileArn || ''}`
      : `${authMethod}:${region}:${clientId || ''}:${profileArn || ''}`
  const h = createHash('sha256').update(seed).digest('hex').slice(0, 16)
  return `${authMethod}-placeholder+${h}@awsapps.local`
}
