import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'
import { createAuditLog } from '@/lib/audit'
import { AuditAction } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ENUM_ROLES = ['SUPERADMIN','ADMIN','HR_HEAD','HR_OFFICER','IT_HEAD','IT_OFFICER','COMPLIANCE_HEAD','COMPLIANCE_OFFICER','EMPLOYEE']

const DEFAULT_PERMS: Record<string, { label: string; canApprove: string; canManageAssets: string; canManageUsers: string; department: string }> = {
  SUPERADMIN: { label: 'Super Admin', canApprove: 'All', canManageAssets: 'All', canManageUsers: 'All', department: 'All' },
  ADMIN: { label: 'Admin', canApprove: 'All', canManageAssets: 'All', canManageUsers: 'All', department: 'All' },
  HR_HEAD: { label: 'HR Head', canApprove: 'Asset Requests, Transfers', canManageAssets: 'View', canManageUsers: 'HR Dept', department: 'HR' },
  HR_OFFICER: { label: 'HR Officer', canApprove: 'Asset Requests', canManageAssets: 'View', canManageUsers: 'HR Dept', department: 'HR' },
  IT_HEAD: { label: 'IT Head', canApprove: 'Asset Requests, Transfers, Accessories', canManageAssets: 'All', canManageUsers: 'IT Dept', department: 'IT' },
  IT_OFFICER: { label: 'IT Officer', canApprove: 'Accessories', canManageAssets: 'All', canManageUsers: 'IT Dept', department: 'IT' },
  COMPLIANCE_HEAD: { label: 'Compliance Head', canApprove: 'High-value Assets', canManageAssets: 'View', canManageUsers: 'Compliance Dept', department: 'COMPLIANCE' },
  COMPLIANCE_OFFICER: { label: 'Compliance Officer', canApprove: 'View', canManageAssets: 'View', canManageUsers: 'Compliance Dept', department: 'COMPLIANCE' },
  EMPLOYEE: { label: 'Employee', canApprove: 'Own Returns', canManageAssets: 'Own Only', canManageUsers: 'Self', department: 'Assigned' },
}

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
    const configs = await prisma.systemConfig.findMany({ where: { category: 'role' } })
    const fromConfigs = configs.map(c => {
      const val = c.value as Record<string, unknown>
      return {
        id: c.id,
        key: c.key,
        code: String(val.code || c.key.replace('role_','')),
        label: String(val.label || val.name || c.key),
        department: String(val.department || 'OTHER'),
        canApprove: String(val.canApprove || ''),
        canManageAssets: String(val.canManageAssets || ''),
        canManageUsers: String(val.canManageUsers || ''),
        description: val.description ? String(val.description) : null,
        isActive: val.isActive !== false,
        source: 'config' as const,
      }
    })
    const configCodes = new Set(fromConfigs.map(r => r.code))
    const enumFallback = ENUM_ROLES.filter(code => !configCodes.has(code)).map(code => ({
      id: `enum_${code}`,
      key: `role_${code}`,
      code,
      label: DEFAULT_PERMS[code]?.label || code,
      department: DEFAULT_PERMS[code]?.department || 'OTHER',
      canApprove: DEFAULT_PERMS[code]?.canApprove || '',
      canManageAssets: DEFAULT_PERMS[code]?.canManageAssets || '',
      canManageUsers: DEFAULT_PERMS[code]?.canManageUsers || '',
      description: null,
      isActive: true,
      source: 'enum' as const,
    }))
    return NextResponse.json({ roles: [...fromConfigs, ...enumFallback] })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'roles error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN','ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { code, label, department, canApprove, canManageAssets, canManageUsers, description, isActive } = await request.json()
    if (!code || !label) return NextResponse.json({ error: 'code and label required' }, { status: 400 })
    const upper = String(code).toUpperCase().replace(/\s+/g,'_')
    const key = `role_${upper}`
    const existing = await prisma.systemConfig.findUnique({ where: { key } })
    if (existing) return NextResponse.json({ error: 'Role code already exists' }, { status: 400 })
    const created = await prisma.systemConfig.create({
      data: { key, category: 'role', value: { code: upper, label, department: department || 'OTHER', canApprove: canApprove || '', canManageAssets: canManageAssets || '', canManageUsers: canManageUsers || '', description: description || '', isActive: isActive !== false }, description: `Role ${label}` }
    })
    await createAuditLog({ actorId: user.id, action: AuditAction.CREATE, entityType: 'Role', entityId: created.id, afterState: created as unknown as Record<string,unknown>, description: `Created role ${upper} - ${label}` })
    return NextResponse.json({ role: created }, { status: 201 })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('POST ' + 'roles error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN','ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { key, code, label, department, canApprove, canManageAssets, canManageUsers, description, isActive } = await request.json()
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    const existing = await prisma.systemConfig.findUnique({ where: { key } })
    // Allow editing enum roles by creating/upserting a config override (non-breaking)
    let before: Record<string, unknown> | null = existing as unknown as Record<string, unknown> | null
    const fallbackCode = key.replace('role_','')
    const isEnumEdit = !existing && ENUM_ROLES.includes(fallbackCode)
    if (isEnumEdit) {
      const defaults = DEFAULT_PERMS[fallbackCode] || { label: fallbackCode, department: 'OTHER', canApprove: '', canManageAssets: '', canManageUsers: '' }
      const value = {
        code: fallbackCode,
        label: label ?? defaults.label,
        department: department ?? defaults.department,
        canApprove: canApprove ?? defaults.canApprove,
        canManageAssets: canManageAssets ?? defaults.canManageAssets,
        canManageUsers: canManageUsers ?? defaults.canManageUsers,
        description: description ?? '',
        isActive: isActive !== undefined ? !!isActive : true,
      }
      const created = await prisma.systemConfig.create({ data: { key, category: 'role', value, description: `Role ${value.label}` } })
      await createAuditLog({ actorId: user.id, action: AuditAction.UPDATE, entityType: 'Role', entityId: created.id, beforeState: defaults as Record<string,unknown>, afterState: created as unknown as Record<string,unknown>, description: `Overrode enum role ${fallbackCode}` })
      return NextResponse.json({ role: created })
    }
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const currentVal = existing.value as Record<string, unknown>
    const nextVal = {
      code: code ? String(code).toUpperCase() : String(currentVal.code || key.replace('role_','')),
      label: label !== undefined ? label : String(currentVal.label || currentVal.name || ''),
      department: department !== undefined ? department : String(currentVal.department || 'OTHER'),
      canApprove: canApprove !== undefined ? canApprove : String(currentVal.canApprove || ''),
      canManageAssets: canManageAssets !== undefined ? canManageAssets : String(currentVal.canManageAssets || ''),
      canManageUsers: canManageUsers !== undefined ? canManageUsers : String(currentVal.canManageUsers || ''),
      description: description !== undefined ? description : String(currentVal.description || ''),
      isActive: isActive !== undefined ? !!isActive : (currentVal.isActive !== false),
    }
    const updated = await prisma.systemConfig.update({ where: { key }, data: { value: nextVal, description: `Role ${nextVal.label}` } })
    await createAuditLog({ actorId: user.id, action: AuditAction.UPDATE, entityType: 'Role', entityId: updated.id, beforeState: before as Record<string,unknown>, afterState: updated as unknown as Record<string,unknown>, description: `Updated role ${nextVal.code}` })
    return NextResponse.json({ role: updated })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('PATCH ' + 'roles error:', error)
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
    const code = key.replace('role_','')
    if (ENUM_ROLES.includes(code)) {
      // Non-breaking: enum roles cannot be deleted, only custom roles
      return NextResponse.json({ error: 'Cannot delete system role (non-breaking constraint)' }, { status: 400 })
    }
    const existing = await prisma.systemConfig.findUnique({ where: { key } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await prisma.systemConfig.delete({ where: { key } })
    await createAuditLog({ actorId: user.id, action: AuditAction.DELETE, entityType: 'Role', entityId: existing.id, beforeState: existing as unknown as Record<string,unknown>, description: `Deleted role ${key}` })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('DELETE ' + 'roles error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
