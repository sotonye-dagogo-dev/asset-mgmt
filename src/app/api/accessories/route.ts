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
    const types = await prisma.accessoryType.findMany({ orderBy: { name: 'asc' } })
    return NextResponse.json({ accessoryTypes: types })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'accessories error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { name, code, description } = await request.json()
  if (!name || !code) return NextResponse.json({ error: 'Name and code required' }, { status: 400 })
  try {
    const created = await prisma.accessoryType.create({ data: { name, code: code.toUpperCase(), description, isActive: true } })
    await createAuditLog({ actorId: user.id, action: AuditAction.CREATE, entityType: 'AccessoryType', entityId: created.id, afterState: created, description: `Created accessory type ${created.name}` })
    return NextResponse.json({ accessoryType: created }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: 'Code or name already exists' }, { status: 400 })
  }
}
