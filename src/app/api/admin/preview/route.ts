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

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'SUPERADMIN') return NextResponse.json({ error: 'Only SUPERADMIN can preview' }, { status: 403 })
  const { role } = await request.json()
  if (!role) return NextResponse.json({ error: 'role required' }, { status: 400 })
  const res = NextResponse.json({ success: true, previewRole: role })
  res.cookies.set('preview-role', role, { httpOnly: false, path: '/', maxAge: 60*60*4, sameSite: 'lax' })
  return res
}

export async function DELETE(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const res = NextResponse.json({ success: true })
  res.cookies.set('preview-role', '', { httpOnly: false, path: '/', maxAge: 0 })
  return res
}

export async function GET(request: NextRequest) {
  const preview = request.cookies.get('preview-role')?.value || null
  return NextResponse.json({ previewRole: preview })
}
