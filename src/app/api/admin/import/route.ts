import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'
import { createAuditLog } from '@/lib/audit'
import { AuditAction } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function getUser(request: NextRequest) {
  const token = request.cookies.get('auth-token')?.value
  if (!token) return null
  const payload = verifyToken(token)
  if (!payload) return null
  return prisma.user.findUnique({ where: { id: payload.id as string } })
}

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const { assets } = await request.json()
    if (!Array.isArray(assets) || assets.length === 0) return NextResponse.json({ error: 'assets array required' }, { status: 400 })

    const results: Array<{ assetId: string; success: boolean; error?: string }> = []
    for (const row of assets) {
      try {
        const assetId = row.assetId || `AST-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
        const created = await prisma.asset.create({
          data: {
            assetId,
            name: row.name || 'Imported Asset',
            category: row.category || 'OTHER',
            brand: row.brand || 'Unknown',
            model: row.model || 'Unknown',
            serialNumber: row.serialNumber || undefined,
            condition: row.condition || 'New',
            status: 'AVAILABLE',
            purchaseDate: row.purchaseDate ? new Date(row.purchaseDate) : undefined,
            purchasePrice: row.purchasePrice ? parseFloat(row.purchasePrice) : undefined,
            location: row.location || undefined,
            createdById: user.id,
          },
        })
        results.push({ assetId: created.assetId, success: true })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error'
        results.push({ assetId: row.assetId || 'unknown', success: false, error: msg })
      }
    }

    await createAuditLog({
      actorId: user.id,
      action: AuditAction.CREATE,
      entityType: 'Asset',
      entityId: 'bulk-import',
      afterState: { count: results.filter(r => r.success).length },
      description: `Bulk imported ${results.filter(r => r.success).length} assets`,
    })

    return NextResponse.json({ results, successCount: results.filter(r => r.success).length, total: assets.length })
  } catch (error) {
    console.error('Import error', error)
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  }
}
