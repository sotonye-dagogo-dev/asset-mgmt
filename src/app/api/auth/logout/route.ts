import { NextRequest, NextResponse } from 'next/server'
import { clearAuthCookie } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST() {
  await clearAuthCookie()
  return NextResponse.json({ success: true })
}

export async function GET(request: NextRequest) {
  await clearAuthCookie()
  const redirectUrl = new URL('/auth/login', request.url)
  return NextResponse.redirect(redirectUrl)
}