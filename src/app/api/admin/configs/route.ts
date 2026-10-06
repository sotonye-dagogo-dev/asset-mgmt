import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDatabaseUnavailableError, databaseUnavailableResponse } from '@/lib/db-errors'
import { verifyToken } from '@/lib/auth'

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
    const configs = await prisma.systemConfig.findMany()
    return NextResponse.json({ configs })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('GET ' + 'configs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!['SUPERADMIN', 'ADMIN'].includes(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { key, value, category, description } = await request.json()
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    const updated = await prisma.systemConfig.upsert({
      where: { key },
      update: { value, category, description },
      create: { key, value, category: category || 'general', description },
    })
    return NextResponse.json({ config: updated })
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return databaseUnavailableResponse(error)
    }
    console.error('PATCH ' + 'configs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
