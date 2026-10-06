import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function getUser(request: NextRequest) {
  const token = request.cookies.get('auth-token')?.value
  if (!token) return null
  const payload = verifyToken(token)
  if (!payload) return null
  return prisma.user.findUnique({ where: { id: payload.id as string } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const [assets, users, approvals, logs] = await Promise.all([
      prisma.asset.findMany(),
      prisma.user.findMany({ select: { id: true, email: true, firstName: true, lastName: true, role: true, department: true, employeeId: true } }),
      prisma.approval.findMany(),
      prisma.auditLog.findMany({ take: 100, orderBy: { createdAt: 'desc' } }),
    ])
    return NextResponse.json({ assets, users, approvals, logs, exportedAt: new Date().toISOString() })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'backup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
