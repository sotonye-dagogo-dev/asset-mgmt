import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'
import { createAuditLog } from '@/lib/audit'
import { AuditAction, ApprovalStatus, Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ApprovalChainStep {
  role: string
  userId: string
  order: number
  status: string
  comments?: string
  decidedAt?: string
}

async function getUser(request: NextRequest) {
  const token = request.cookies.get('auth-token')?.value
  if (!token) return null
  const payload = verifyToken(token)
  if (!payload) return null
  return prisma.user.findUnique({ where: { id: payload.id as string } })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
    const { id } = await params
    const { action, comments } = await request.json()
  
    const approval = await prisma.approval.findUnique({
      where: { id },
      include: {
        requester: true,
        asset: true,
        currentApprover: true,
      },
    })
  
    if (!approval) return NextResponse.json({ error: 'Approval not found' }, { status: 404 })
  
    if (approval.currentApproverId !== user.id && !['SUPERADMIN', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ error: 'Not authorized to approve this request' }, { status: 403 })
    }
  
    if (approval.status !== 'PENDING') {
      return NextResponse.json({ error: 'Approval already processed' }, { status: 400 })
    }
  
    const chain = approval.approvalChain as unknown as ApprovalChainStep[]
    const currentStep = chain.find((step) => step.userId === user.id)
  
    if (!currentStep && !['SUPERADMIN', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ error: 'Not in approval chain' }, { status: 403 })
    }
  
    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'
  
    if (currentStep) {
      currentStep.status = newStatus
      currentStep.comments = comments
      currentStep.decidedAt = new Date().toISOString()
    }
  
    let finalStatus: ApprovalStatus = newStatus as ApprovalStatus
    let nextApproverId: string | null = null
  
    if (action === 'approve') {
      const nextStep = chain.find((step) => step.status === 'PENDING' && step.order > (currentStep?.order || 0))
      if (nextStep) {
        finalStatus = 'PENDING'
        nextApproverId = nextStep.userId
      } else {
        finalStatus = 'APPROVED'
      }
    } else {
      finalStatus = 'REJECTED'
    }
  
    const updatedApproval = await prisma.approval.update({
      where: { id },
      data: {
        status: finalStatus,
        approvalChain: chain as unknown as Prisma.InputJsonValue,
        currentApproverId: nextApproverId,
        decidedAt: finalStatus !== 'PENDING' ? new Date() : null,
        comments: comments || approval.comments,
      },
    })
  
    if (finalStatus === 'APPROVED') {
      await executeApproval(approval, user)
    }
  
    await createAuditLog({
      actorId: user.id,
      action: action === 'approve' ? AuditAction.APPROVE : AuditAction.REJECT,
      entityType: 'Approval',
      entityId: id,
      afterState: updatedApproval,
      description: `${action === 'approve' ? 'Approved' : 'Rejected'} ${approval.type} request`,
    })
  
    return NextResponse.json({ approval: updatedApproval })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('PATCH ' + '[id] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function executeApproval(approval: { type: string; requesterId: string; assetId: string | null }, approver: { firstName: string; lastName: string }) {
  if (!approval.assetId) return
  
  switch (approval.type) {
    case 'ASSET_REQUEST':
      await prisma.acknowledgement.create({
        data: {
          userId: approval.requesterId,
          assetId: approval.assetId,
          type: 'ISSUE',
          statement: `Asset request approved by ${approver.firstName} ${approver.lastName}. Ready for issuance.`,
          agreed: true,
          agreedAt: new Date(),
        },
      })
      break
    case 'ASSET_RETURN':
      await prisma.acknowledgement.create({
        data: {
          userId: approval.requesterId,
          assetId: approval.assetId,
          type: 'RETURN',
          statement: `Asset return approved by ${approver.firstName} ${approver.lastName}.`,
          agreed: true,
          agreedAt: new Date(),
        },
      })
      break
  }
}