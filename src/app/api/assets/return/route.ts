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
  
  try {
    const { assetId, condition, notes, accessoryIds } = await request.json()
    
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { assignedTo: true, accessories: true },
    })
    
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    
    if (asset.assignedToId !== user.id && !['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER'].includes(user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    
    // Update asset
    const updatedAsset = await prisma.asset.update({
      where: { id: assetId },
      data: {
        assignedToId: null,
        assignedById: null,
        assignedAt: null,
        status: condition === 'DAMAGED' ? 'DAMAGED' : 'AVAILABLE',
        expectedReturnDate: null,
        condition: condition || asset.condition,
        remarks: notes ? `${asset.remarks || ''}\nReturn: ${notes}`.trim() : asset.remarks,
      },
      include: { assignedTo: true },
    })
    
    // Return accessories
    if (accessoryIds?.length) {
      await prisma.asset.updateMany({
        where: { id: { in: accessoryIds } },
        data: { assignedToId: null, assignedById: null, assignedAt: null, status: 'AVAILABLE' },
      })
    } else {
      // Auto-return all accessories
      await prisma.asset.updateMany({
        where: { parentAssetId: assetId },
        data: { assignedToId: null, assignedById: null, assignedAt: null, status: 'AVAILABLE' },
      })
    }
    
    // Create acknowledgement for return
    await prisma.acknowledgement.create({
      data: {
        userId: user.id,
        assetId,
        type: 'RETURN',
        statement: `I confirm the return of ${asset.name} (${asset.assetId}) in ${condition || 'good'} condition.`,
        agreed: true,
        agreedAt: new Date(),
        signedStatement: `${user.firstName} ${user.lastName}`,
      },
    })
    
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.RETURN,
      entityType: 'Asset',
      entityId: assetId,
      beforeState: { status: asset.status, assignedToId: asset.assignedToId },
      afterState: { status: updatedAsset.status, assignedToId: null },
      description: `Returned asset ${asset.assetId} by ${user.firstName} ${user.lastName}`,
    })
    
    return NextResponse.json({ asset: updatedAsset })
  } catch (error) {
    console.error('Return asset error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}