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

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { id } = await params
    const data = await request.json()
    const before = await prisma.accessoryType.findUnique({ where: { id } })
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const updated = await prisma.accessoryType.update({ where: { id }, data: { name: data.name, code: data.code?.toUpperCase(), description: data.description, isActive: data.isActive } })
    await createAuditLog({ actorId: user.id, action: AuditAction.UPDATE, entityType: 'AccessoryType', entityId: id, beforeState: before, afterState: updated, description: `Updated accessory type ${updated.name}` })
    return NextResponse.json({ accessoryType: updated })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('PATCH ' + '[id] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { id } = await params
    await prisma.accessoryType.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('DELETE ' + '[id] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
