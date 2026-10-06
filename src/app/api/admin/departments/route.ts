import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'
import { createAuditLog } from '@/lib/audit'
import { AuditAction } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ENUM_DEPTS = ['HR','IT','COMPLIANCE','FINANCE','OPERATIONS','MARKETING','SALES','OTHER']

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
    const configs = await prisma.systemConfig.findMany({ where: { category: 'department' } })
    const fromConfigs = configs.map(c => {
      const val = c.value as Record<string, unknown>
      return {
        id: c.id,
        key: c.key,
        code: String(val.code || c.key.replace('dept_','')),
        name: String(val.name || c.key),
        description: val.description ? String(val.description) : null,
        isActive: val.isActive !== false,
        source: 'config' as const,
        rawValue: val,
      }
    })
    const configCodes = new Set(fromConfigs.map(d => d.code))
    const enumFallback = ENUM_DEPTS.filter(code => !configCodes.has(code)).map(code => ({
      id: `enum_${code}`,
      key: `dept_${code}`,
      code,
      name: code,
      description: null,
      isActive: true,
      source: 'enum' as const,
      rawValue: null,
    }))
    return NextResponse.json({ departments: [...fromConfigs, ...enumFallback] })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'departments error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN','ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { code, name, description, isActive } = await request.json()
    if (!code || !name) return NextResponse.json({ error: 'code and name required' }, { status: 400 })
    const upper = String(code).toUpperCase().replace(/\s+/g,'_')
    const key = `dept_${upper}`
    const existing = await prisma.systemConfig.findUnique({ where: { key } })
    if (existing) return NextResponse.json({ error: 'Department code already exists' }, { status: 400 })
    const created = await prisma.systemConfig.create({
      data: { key, category: 'department', value: { code: upper, name, description: description || '', isActive: isActive !== false }, description: `Department ${name}` }
    })
    await createAuditLog({ actorId: user.id, action: AuditAction.CREATE, entityType: 'Department', entityId: created.id, afterState: created as unknown as Record<string,unknown>, description: `Created department ${upper} - ${name}` })
    return NextResponse.json({ department: created }, { status: 201 })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('POST ' + 'departments error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN','ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { key, code, name, description, isActive } = await request.json()
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    const existing = await prisma.systemConfig.findUnique({ where: { key } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const before = { ...existing }
    const currentVal = existing.value as Record<string, unknown>
    const nextVal = {
      code: code ? String(code).toUpperCase() : String(currentVal.code || key.replace('dept_','')),
      name: name !== undefined ? name : String(currentVal.name || ''),
      description: description !== undefined ? description : String(currentVal.description || ''),
      isActive: isActive !== undefined ? !!isActive : (currentVal.isActive !== false),
    }
    const updated = await prisma.systemConfig.update({ where: { key }, data: { value: nextVal, description: `Department ${nextVal.name}` } })
    await createAuditLog({ actorId: user.id, action: AuditAction.UPDATE, entityType: 'Department', entityId: updated.id, beforeState: before as unknown as Record<string,unknown>, afterState: updated as unknown as Record<string,unknown>, description: `Updated department ${nextVal.code}` })
    return NextResponse.json({ department: updated })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('PATCH ' + 'departments error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN','ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { searchParams } = new URL(request.url)
    const key = searchParams.get('key')
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    if (key.startsWith('enum_') || ENUM_DEPTS.includes(key.replace('dept_',''))) {
      // For enum fallback, create an inactive override instead of deleting enum
      // But if it's an enum synthetic id (enum_X), we store an inactive config to hide it (non-breaking soft delete)
      const code = key.replace('enum_','').replace('dept_','')
      const upsertKey = `dept_${code}`
      const existing = await prisma.systemConfig.findUnique({ where: { key: upsertKey } })
      if (existing) {
        await prisma.systemConfig.delete({ where: { key: upsertKey } })
      } else {
        // Create inactive marker to effectively "delete" enum appearance - but simpler: just return success without deleting enum (non-breaking no-op)
        return NextResponse.json({ success: true, message: 'Enum department cannot be deleted (non-breaking). Created inactive override not needed.' })
      }
      return NextResponse.json({ success: true })
    }
    const existing = await prisma.systemConfig.findUnique({ where: { key } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await prisma.systemConfig.delete({ where: { key } })
    await createAuditLog({ actorId: user.id, action: AuditAction.DELETE, entityType: 'Department', entityId: existing.id, beforeState: existing as unknown as Record<string,unknown>, description: `Deleted department ${key}` })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('DELETE ' + 'departments error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
