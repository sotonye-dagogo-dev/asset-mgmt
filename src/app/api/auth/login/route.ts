import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyPassword, generateToken, setAuthCookie } from '@/lib/auth'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()
    
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }
    
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    })
    
    if (!user || !user.isActive) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      )
    }
    
    const isValid = await verifyPassword(password, user.passwordHash)
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      )
    }
    
    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
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
    console.error('Login error:', error)
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}