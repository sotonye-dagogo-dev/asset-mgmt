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
  
    // Users can view their own profile, admins can view all
    if (user.id !== id && !['SUPERADMIN', 'ADMIN', 'HR_HEAD', 'HR_OFFICER'].includes(user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  
    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        employeeId: true,
        jobTitle: true,
        department: true,
        role: true,
        campus: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        supervisor: { select: { id: true, firstName: true, lastName: true } },
        subordinates: { select: { id: true, firstName: true, lastName: true, role: true } },
        assignedAssets: { select: { id: true, assetId: true, name: true, status: true } },
      },
    })
  
    if (!targetUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  
    return NextResponse.json({ user: targetUser })
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
  
  // Users can update their own profile (limited fields), admins can update all
  const isAdmin = ['SUPERADMIN', 'ADMIN', 'HR_HEAD', 'HR_OFFICER'].includes(user.role)
  if (user.id !== id && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  
  const targetUser = await prisma.user.findUnique({ where: { id } })
  if (!targetUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  
  try {
    const data = await request.json()
    const beforeState = { ...targetUser }
    
    // Filter allowed fields based on role
    const allowedFields = isAdmin
      ? ['firstName', 'lastName', 'jobTitle', 'department', 'role', 'campus', 'employeeId', 'supervisorId', 'isActive']
      : ['firstName', 'lastName', 'jobTitle', 'campus']
    
    const updateData: Record<string, unknown> = {}
    for (const field of allowedFields) {
      if (data[field] !== undefined) updateData[field] = data[field]
    }
    
    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        employeeId: true,
        jobTitle: true,
        department: true,
        role: true,
        campus: true,
        isActive: true,
      },
    })
    
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: id,
      beforeState,
      afterState: updatedUser,
      description: `Updated user ${targetUser.email}`,
    })
    
    return NextResponse.json({ user: updatedUser })
  } catch (error) {
    console.error('Update user error:', error)
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
  
    if (id === user.id) {
      return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 })
    }
  
    const targetUser = await prisma.user.findUnique({ where: { id } })
    if (!targetUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  
    // Soft delete - deactivate
    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    })
  
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.DELETE,
      entityType: 'User',
      entityId: id,
      beforeState: targetUser,
      description: `Deactivated user ${targetUser.email}`,
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