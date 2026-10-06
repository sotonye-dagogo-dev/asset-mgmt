import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'
import { hashPassword } from '@/lib/auth'
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
  
    // Only admins and HR can list users
    if (!['SUPERADMIN', 'ADMIN', 'HR_HEAD', 'HR_OFFICER'].includes(user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  
    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '25')
    const department = searchParams.get('department')
    const role = searchParams.get('role')
    const search = searchParams.get('search')
  
    const where: Record<string, unknown> = {}
    if (department) where.department = department
    if (role) where.role = role
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { employeeId: { contains: search, mode: 'insensitive' } },
      ]
    }
  
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
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
          _count: { select: { assignedAssets: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ])
  
    return NextResponse.json({ users, total, page, pageSize })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'users error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  
  // Only superadmin and admin can create users
  if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  
  try {
    const { email, password, firstName, lastName, department, role, jobTitle, employeeId, campus, supervisorId } = await request.json()
    
    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    })
    
    if (existingUser) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 400 })
    }
    
    const passwordHash = await hashPassword(password)
    
    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        department: department || 'OTHER',
        role: role || 'EMPLOYEE',
        jobTitle,
        employeeId,
        campus,
        supervisorId,
        invitedById: user.id,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        department: true,
        role: true,
        createdAt: true,
      },
    })
    
    await createAuditLog({
      actorId: user.id,
      action: AuditAction.CREATE,
      entityType: 'User',
      entityId: newUser.id,
      afterState: newUser,
      description: `Created user ${newUser.email} with role ${newUser.role}`,
    })
    
    return NextResponse.json({ user: newUser }, { status: 201 })
  } catch (error) {
    console.error('Create user error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}