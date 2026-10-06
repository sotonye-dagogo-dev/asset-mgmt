// Shared DB error handling — converts Prisma connection/config failures
// (e.g. Supabase pooler ENOTFOUND tenant/user) into actionable 503 responses
// instead of opaque 500s, so the UI can report "DB unavailable" vs "no data".
import { NextResponse } from 'next/server'
import { getDatabaseConfigError } from './prisma'

const UNAVAILABLE_PATTERNS = [
  'ENOTFOUND',
  'tenant/user',
  'tenant or user not found',
  'failed to resolve',
  'getaddrinfo',
  'connection refused',
  'timed out',
  'P1000',
  'P1001',
  'P1002',
  'P1017',
  ' PrismaClientInitializationError',
  'Error querying the database',
  "Can't reach database server",
  'Authentication failed',
]

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  const msg = messageOf(error)
  return UNAVAILABLE_PATTERNS.some((p) => msg.includes(p))
}

/** Build a 503 JSON response with remediation hints for DB connectivity failures. */
export function databaseUnavailableResponse(error: unknown) {
  const detail = messageOf(error).slice(0, 500)
  const configHint = getDatabaseConfigError()
  // Keep server logs full; client gets a safe, actionable summary.
  console.error('[db] Database unavailable:', detail)
  if (configHint) console.error('[db] Config hint:', configHint)
  return NextResponse.json(
    {
      error: 'Database unavailable',
      code: 'DB_UNAVAILABLE',
      detail:
        'The application could not reach the database. Verify DATABASE_URL/DIRECT_URL (Supabase pooler user must be postgres.<PROJECT_REF> with URL-encoded password, host :6543 with ?pgbouncer=true&connection_limit=1, migrations via :5432 DIRECT_URL).',
      ...(process.env.NODE_ENV !== 'production' ? { cause: detail } : {}),
    },
    { status: 503 }
  )
}

/** Wrap an API handler so DB connection failures always become 503s. */
export async function withDatabaseSafety<T>(fn: () => Promise<T>, fallback: (e: unknown) => NextResponse): Promise<T | NextResponse> {
  try {
    return await fn()
  } catch (error) {
    if (isDatabaseUnavailableError(error)) return databaseUnavailableResponse(error) as unknown as T
    return fallback(error)
  }
}

export function isDbUnavailableMessage(message: string): boolean {
  return UNAVAILABLE_PATTERNS.some((p) => message.includes(p))
}
