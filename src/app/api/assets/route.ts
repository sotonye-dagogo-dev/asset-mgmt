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
    const category = searchParams.get('category')
    const assignedToId = searchParams.get('assignedToId')
    const search = searchParams.get('search')
  
    const where: Record<string, unknown> = {}
  
    if (status) where.status = status
    if (category) where.category = category
    if (assignedToId) where.assignedToId = assignedToId
    if (search) {
      where.OR = [
        { assetId: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
      ]
    }
  
    // Non-admins can only see their assigned assets
    if (!['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER', 'HR_HEAD', 'HR_OFFICER', 'COMPLIANCE_HEAD', 'COMPLIANCE_OFFICER'].includes(user.role)) {
      where.assignedToId = user.id
    }
  
    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        include: {
          assignedTo: { select: { id: true, firstName: true, lastName: true, email: true, department: true } },
          assignedBy: { select: { id: true, firstName: true, lastName: true } },
          accessories: { select: { id: true, assetId: true, name: true, accessoryId: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.asset.count({ where }),
    ])
  
    return NextResponse.json({ assets, total, page, pageSize })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'assets error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
  // Only admins and IT can create assets
  if (!['SUPERADMIN', 'ADMIN', 'IT_HEAD', 'IT_OFFICER'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  
  try {
    const data = await request.json()
    const { accessories, ...assetData } = data
    
    const asset = await prisma.asset.create({
      data: {
        ...assetData,
        assetId: assetData.assetId || `AST-${Date.now().toString(36).toUpperCase()}`,
        createdById: user.id,
        accessories: accessories?.length ? {
          create: accessories.map((acc: Record<string, unknown>) => ({
            ...acc,
            assetId: acc.assetId || `AST-${Date.now().toString(36).toUpperCase()}-ACC`,
            category: acc.category || 'OTHER',
            accessoryId: acc.accessoryId || `ACC-${acc.code || 'ACC'}-${Date.now().toString(36).toUpperCase()}`,
            parentAssetId: '', // Will be set after parent creation
          }))
        } : undefined,
      },
      include: { accessories: true },
    })
    
    // Update accessories with parentAssetId
    if (accessories?.length) {
      await Promise.all(
        asset.accessories.map((acc) =>
          prisma.asset.update({
            where: { id: acc.id },
            data: { parentAssetId: asset.id },
          })
        )
      )
    }
    
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.CREATE,
      entityType: 'Asset',
      entityId: asset.id,
      afterState: asset,
      description: `Created asset ${asset.assetId} - ${asset.name}`,
    })
    
    return NextResponse.json({ asset }, { status: 201 })
  } catch (error) {
    console.error('Create asset error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}