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
  
  // Only admins and IT can assign assets
  if (!['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  
  try {
    const { assetId, assigneeId, expectedReturnDate, accessories: accessoryIds, notes } = await request.json()
    
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { assignedTo: true, accessories: true },
    })
    
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    
    const isReassignment = asset.status === 'ASSIGNED' && asset.assignedToId && asset.assignedToId !== assigneeId
    const previousAssigneeId = asset.assignedToId
    
    const assignee = await prisma.user.findUnique({ where: { id: assigneeId } })
    if (!assignee) return NextResponse.json({ error: 'Assignee not found' }, { status: 404 })
    
    // Check if asset has accessories that need to be assigned too
    const accessories = await prisma.asset.findMany({
      where: { parentAssetId: assetId },
    })
    
    // Create assignment (or reassignment/transfer)
    const updatedAsset = await prisma.asset.update({
      where: { id: assetId },
      data: {
        assignedToId: assigneeId,
        assignedById: user.id,
        assignedAt: new Date(),
        status: 'ASSIGNED',
        expectedReturnDate: expectedReturnDate ? new Date(expectedReturnDate) : null,
      },
      include: { assignedTo: true },
    })

    if (isReassignment) {
      await prisma.assetTransfer.create({
        data: {
          assetId,
          fromUserId: previousAssigneeId,
          toUserId: assigneeId,
          reason: notes || 'Reassigned via admin',
          approvedById: user.id,
          approvedAt: new Date(),
        },
      })
    }
    
    // Assign accessories from request or auto-assign all
    if (accessoryIds && accessoryIds.length > 0) {
      await prisma.asset.updateMany({
        where: { id: { in: accessoryIds } },
        data: { assignedToId: assigneeId, assignedById: user.id, assignedAt: new Date(), status: 'ASSIGNED' },
      })
    } else if (asset.accessories && asset.accessories.length > 0) {
      // Auto-assign all accessories
      await prisma.asset.updateMany({
        where: { parentAssetId: assetId },
        data: { assignedToId: assigneeId, assignedById: user.id, assignedAt: new Date(), status: 'ASSIGNED' },
      })
    }
    
    // Create acknowledgement record
    await prisma.acknowledgement.create({
      data: {
        userId: assigneeId,
        assetId,
        type: 'ISSUE',
        statement: `I acknowledge receipt of ${asset.name} (${asset.assetId}) in good working condition. I understand that the asset remains the property of the organisation and is issued strictly for authorised business purposes. I am responsible for proper care, security and appropriate use. I will not sell, transfer, lend, dispose of, alter or permit unauthorised persons to use the asset. I will immediately report any loss, theft, damage or malfunction. I will return the asset including all accessories upon request, transfer, resignation, termination or when no longer required.`,
        agreed: false,
      },
    })
    
    // Create audit log
    await createAuditLog({
      actorId: user.id,
      action: isReassignment ? AuditAction.TRANSFER : AuditAction.ASSIGN,
      entityType: 'Asset',
      entityId: assetId,
      beforeState: { status: asset.status, assignedToId: asset.assignedToId },
      afterState: { status: 'ASSIGNED', assignedToId: assigneeId },
      description: isReassignment
        ? `Transferred asset ${asset.assetId} from ${asset.assignedTo?.firstName || previousAssigneeId} to ${assignee.firstName} ${assignee.lastName}`
        : `Assigned asset ${asset.assetId} to ${assignee.firstName} ${assignee.lastName}`,
      metadata: { previousAssigneeId, notes } as Record<string, unknown>,
    })
    
    return NextResponse.json({ asset: updatedAsset })
  } catch (error) {
    console.error('Assign asset error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}