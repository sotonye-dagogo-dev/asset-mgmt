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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
    const { id } = await params
  
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true, department: true, employeeId: true, jobTitle: true } },
        assignedBy: { select: { id: true, firstName: true, lastName: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        accessories: { include: { assignedTo: { select: { id: true, firstName: true, lastName: true } } } },
        acknowledgements: {
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
  
    if (!asset) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    }
  
    // Fetch audit logs separately (polymorphic relation)
    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: 'Asset', entityId: id },
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  
    return NextResponse.json({ asset: { ...asset, auditLogs } })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + '[id] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
  const { id } = await params
  
  const asset = await prisma.asset.findUnique({ where: { id } })
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
  
  // Check permissions
  if (!['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  
  try {
    const data = await request.json()
    const beforeState = { ...asset }
    
    const updatedAsset = await prisma.asset.update({
      where: { id },
      data,
      include: {
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
        accessories: true,
      },
    })

    // Determine audit action based on assignment change
    let action: AuditAction = AuditAction.UPDATE
    let description = `Updated asset ${asset.assetId}`
    if (data.assignedToId !== undefined && data.assignedToId !== asset.assignedToId) {
      if (data.assignedToId === null) {
        action = AuditAction.UNASSIGN
        description = `Unassigned asset ${asset.assetId} from ${asset.assignedToId || 'previous assignee'}`
      } else if (asset.assignedToId) {
        action = AuditAction.TRANSFER
        description = `Transferred asset ${asset.assetId} from ${asset.assignedToId} to ${data.assignedToId}`
      } else {
        action = AuditAction.ASSIGN
        description = `Assigned asset ${asset.assetId} to ${data.assignedToId}`
      }
    }
    
    await createAuditLog({
      actorId: user.id,
      action,
      entityType: 'Asset',
      entityId: id,
      beforeState,
      afterState: updatedAsset,
      description,
    })
    
    return NextResponse.json({ asset: updatedAsset })
  } catch (error) {
    console.error('Update asset error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
    if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  
    const { id } = await params
  
    const asset = await prisma.asset.findUnique({ where: { id } })
    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
  
    await prisma.asset.delete({ where: { id } })
  
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.DELETE,
      entityType: 'Asset',
      entityId: id,
      beforeState: asset,
      description: `Deleted asset ${asset.assetId}`,
    })
  
    return NextResponse.json({ success: true })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('DELETE ' + '[id] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}