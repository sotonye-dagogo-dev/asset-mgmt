import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { hashPassword, generateToken, setAuthCookie } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const { email, password, firstName, lastName, department, role, jobTitle, employeeId, campus } = await request.json()
    
    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }
    
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    })
    
    if (existingUser) {
      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 400 }
      )
    }
    
    const passwordHash = await hashPassword(password)
    
    const user = await prisma.user.create({
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
      },
    })
    
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      firstName: user.firstName,
      lastName: user.lastName,
    })
    
    await setAuthCookie(token)
    
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        department: user.department,
      },
    })
  } catch (error) {
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}