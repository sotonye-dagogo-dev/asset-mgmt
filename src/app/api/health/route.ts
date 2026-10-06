import { NextResponse } from 'next/server'
import { prisma, getDatabaseConfigError } from '@/lib/prisma'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/health — DB compliance probe.
 * Returns { status, db: { reachable, latencyMs, counts }, configError? }.
 * Used to prove the platform reads from the live DB (not mock data).
 */
export async function GET() {
  const started = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    const latencyMs = Date.now() - started
    const [users, assets, approvals, auditLogs] = await Promise.all([
      prisma.user.count(),
      prisma.asset.count(),
      prisma.approval.count(),
      prisma.auditLog.count(),
    ])
    return NextResponse.json({
      status: 'ok',
      db: {
        reachable: true,
        latencyMs,
        counts: { users, assets, approvals, auditLogs },
        source: 'live-database',
      },
      configError: getDatabaseConfigError(),
    })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error('[health] DB unreachable:', message)
    return NextResponse.json(
      {
        status: 'degraded',
        db: { reachable: false, latencyMs: Date.now() - started, source: 'live-database' },
        code: 'DB_UNAVAILABLE',
        configError: getDatabaseConfigError(),
        hint: 'Verify DATABASE_URL (pooler user postgres.<REF>, URL-encoded password, :6543?pgbouncer=true&connection_limit=1) and DIRECT_URL (:5432).',
        ...(process.env.NODE_ENV !== 'production' ? { cause: message.slice(0, 500) } : {}),
      },
      { status: 503 }
    )
  }
}
