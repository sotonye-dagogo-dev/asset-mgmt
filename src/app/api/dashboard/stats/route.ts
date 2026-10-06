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

    const [totalAssets, assigned, available, pendingApprovals, maintenance, retired, totalUsers, recentAssets, pendingList] = await Promise.all([
      prisma.asset.count(),
      prisma.asset.count({ where: { status: 'ASSIGNED' } }),
      prisma.asset.count({ where: { status: 'AVAILABLE' } }),
      prisma.approval.count({ where: { status: 'PENDING' } }),
      prisma.asset.count({ where: { status: 'MAINTENANCE' } }),
      prisma.asset.count({ where: { status: 'RETIRED' } }),
      prisma.user.count({ where: { isActive: true } }),
      prisma.asset.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { assignedTo: { select: { firstName: true, lastName: true } } },
      }),
      prisma.approval.findMany({
        where: { status: 'PENDING' },
        orderBy: { requestedAt: 'desc' },
        take: 5,
        include: {
          asset: { select: { name: true, assetId: true } },
          requester: { select: { firstName: true, lastName: true } },
        },
      }),
    ])

    // Calculate change placeholders (could compute vs last month)
    const byCategory = await prisma.asset.groupBy({ by: ['category'], _count: true })
    const byStatus = await prisma.asset.groupBy({ by: ['status'], _count: true })

    return NextResponse.json({
      stats: { totalAssets, assigned, available, pendingApprovals, maintenance, retired, totalUsers },
      byCategory,
      byStatus,
      recentAssets,
      pendingApprovals: pendingList,
    })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'stats error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
