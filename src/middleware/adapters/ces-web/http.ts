const TOKEN_KEY = 'openplc-ces-session-token'

function captureTokenFromFragment(): string {
  if (typeof window === 'undefined') return ''

  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const token = params.get('token') ?? ''
  if (!token) return ''

  window.sessionStorage.setItem(TOKEN_KEY, token)

  // Keep the session token out of the visible URL/history after bootstrap.
  params.delete('token')
  const remainingFragment = params.toString()
  const cleanUrl = `${window.location.pathname}${window.location.search}${
    remainingFragment ? `#${remainingFragment}` : ''
  }`
  window.history.replaceState(window.history.state, '', cleanUrl)

  return token
}

export function getCesSessionToken(): string {
  if (typeof window === 'undefined') return ''
  return captureTokenFromFragment() || window.sessionStorage.getItem(TOKEN_KEY) || ''
}

export function resolveCesApiPath(path: string): string {
  // Keep API requests relative to the document directory. Standalone CES-web is
  // served at `/`, while embedded CES sessions are served under a session proxy
  // prefix such as `/api/v1/.../proxy/`. A relative `api/...` path works in both
  // cases without teaching the editor anything about CES routing.
  return path.replace(/^\/+/, '')
}

export async function cesApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getCesSessionToken()
  const headers = new Headers(init.headers)

  if (!headers.has('content-type') && init.body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  if (token) headers.set('x-ces-editor-token', token)

  const response = await fetch(resolveCesApiPath(path), { ...init, headers })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  return body
}
