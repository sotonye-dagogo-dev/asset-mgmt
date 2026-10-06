// Prisma Client Singleton — hardened for Supabase pooler + Vercel.
// - Validates DATABASE_URL/DIRECT_URL presence with actionable errors.
// - Normalizes the legacy malformed "?schema=public?pgbouncer=true" form.
// - Auto-appends pgbouncer=true&connection_limit=1 for :6543 pooler URLs.
import { PrismaClient } from '@prisma/client'

function normalizeDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw
  // Fix legacy double-"?" form: "?schema=public?pgbouncer=true" -> "?schema=public&pgbouncer=true"
  let fixed = raw
  const qIndex = fixed.indexOf('?')
  if (qIndex !== -1) {
    const base = fixed.slice(0, qIndex + 1)
    const rest = fixed.slice(qIndex + 1).replace(/\?/g, '&')
    fixed = base + rest
  }
  try {
    const url = new URL(fixed)
    const isPooler6543 = url.port === '6543' || url.hostname.includes('pooler.supabase.com')
    if (isPooler6543) {
      if (!url.searchParams.has('pgbouncer')) url.searchParams.set('pgbouncer', 'true')
      if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '1')
      fixed = url.toString()
    }
  } catch {
    // Leave unparsable URLs alone — Prisma will surface the error.
  }
  return fixed
}

function describeConfigProblem(): string | null {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    return 'DATABASE_URL is not set. Set a pooled connection string (e.g. Supabase :6543 with pgbouncer=true).'
  }
  if (dbUrl.includes('?schema=public?') || /\?.*\?/.test(dbUrl)) {
    return 'DATABASE_URL contains a second "?" in the query string — use "&" to join params (e.g. ?pgbouncer=true&connection_limit=1).'
  }
  // Detect unencoded special chars in password portion userinfo
  try {
    const url = new URL(dbUrl)
    // If password contains characters that break parsing, URL() throws or userinfo is off.
    if (!url.hostname) return 'DATABASE_URL hostname could not be parsed — check for unencoded special characters in the password.'
  } catch {
    return 'DATABASE_URL could not be parsed as a URL — check for unencoded special characters (@, /, ?, #, %) in the password (URL-encode them).'
  }
  // Supabase pooler tenant check: user must be postgres.<PROJECT_REF> on pooler hosts
  try {
    const url = new URL(normalizeDatabaseUrl(dbUrl) as string)
    if (url.hostname.includes('pooler.supabase.com') && url.username === 'postgres') {
      return 'DATABASE_URL uses user "postgres" against a Supabase pooler host — use "postgres.<PROJECT_REF>" as the username.'
    }
  } catch {
    // ignore
  }
  return null
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  const problem = describeConfigProblem()
  if (problem && process.env.NODE_ENV !== 'test') {
    // Log once with actionable guidance; Prisma will still throw on connect,
    // but API handlers convert that into a 503 with the same guidance.
    console.error(`[prisma] Database configuration problem: ${problem}`)
  }
  // Apply normalization via env override so the underlying engine sees the fixed URL.
  const normalized = normalizeDatabaseUrl(process.env.DATABASE_URL)
  if (normalized && normalized !== process.env.DATABASE_URL) {
    process.env.DATABASE_URL = normalized
  }
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

export const prisma = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export function getDatabaseConfigError(): string | null {
  return describeConfigProblem()
}

export default prisma
