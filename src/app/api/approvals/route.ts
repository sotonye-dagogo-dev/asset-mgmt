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

export async function GET(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '25')
    const status = searchParams.get('status')
    const type = searchParams.get('type')
  
    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (type) where.type = type
  
    // Non-admins see only their approvals
    if (!['SUPERADMIN', 'ADMIN', 'HR_HEAD', 'HR_OFFICER', 'COMPLIANCE_HEAD', 'COMPLIANCE_OFFICER'].includes(user.role)) {
      where.requesterId = user.id
    }
  
    const [approvals, total] = await Promise.all([
      prisma.approval.findMany({
        where,
        include: {
          requester: { select: { id: true, firstName: true, lastName: true, email: true, department: true } },
          asset: { select: { id: true, assetId: true, name: true, category: true } },
          currentApprover: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.approval.count({ where }),
    ])
  
    return NextResponse.json({ approvals, total, page, pageSize })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'approvals error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
  try {
    const { type, assetId, accessoryIds, reason, priority } = await request.json()
    
    // Build approval chain based on type and asset
    const approvalChain = await buildApprovalChain(user, type, assetId)
    
    const approval = await prisma.approval.create({
      data: {
        type,
        requesterId: user.id,
        assetId,
        accessoryIds: accessoryIds || [],
        approvalChain,
        priority: priority || 1,
        reason,
        currentApproverId: approvalChain[0]?.userId,
      },
      include: {
        requester: { select: { id: true, firstName: true, lastName: true, email: true } },
        asset: { select: { id: true, assetId: true, name: true } },
      },
    })
    
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.CREATE,
      entityType: 'Approval',
      entityId: approval.id,
      afterState: approval,
      description: `Created ${type} approval request`,
    })
    
    return NextResponse.json({ approval }, { status: 201 })
  } catch (error) {
    console.error('Create approval error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function buildApprovalChain(requester: Record<string, unknown>, type: string, assetId?: string) {
  const chain = []
  let order = 1
  
  // Get department heads
  const hrHead = await prisma.user.findFirst({
    where: { department: 'HR', role: 'HR_HEAD', isActive: true },
  })
  const itHead = await prisma.user.findFirst({
    where: { department: 'IT', role: 'IT_HEAD', isActive: true },
  })
  const complianceHead = await prisma.user.findFirst({
    where: { department: 'COMPLIANCE', role: 'COMPLIANCE_HEAD', isActive: true },
  })
  
  // Always require HR approval for asset requests
  if (type === 'ASSET_REQUEST' || type === 'ASSET_TRANSFER') {
    if (hrHead) chain.push({ role: 'HR_HEAD', userId: hrHead.id, order: order++, status: 'PENDING' })
  }
  
  // IT approval for IT assets
  if (itHead && (type === 'ASSET_REQUEST' || type === 'ASSET_TRANSFER' || type === 'ACCESSORY_REQUEST')) {
    chain.push({ role: 'IT_HEAD', userId: itHead.id, order: order++, status: 'PENDING' })
  }
  
  // Compliance approval for high-value or sensitive assets
  if (complianceHead && assetId) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } })
    if (asset && (asset.purchasePrice || 0) > 100000) { // High value threshold
      chain.push({ role: 'COMPLIANCE_HEAD', userId: complianceHead.id, order: order++, status: 'PENDING' })
    }
  }
  
  return chain
}