// netlify/functions/instagram-proxy.js
//
// graph.instagram.com does not send CORS headers permissive enough for
// direct browser fetch() calls — requests made straight from the frontend
// fail with a generic, unhelpful "NetworkError when attempting to fetch
// resource" (Firefox) or a similarly opaque failure in Chrome.
//
// This function proxies GET requests to graph.instagram.com server-side,
// where CORS doesn't apply, and returns the JSON straight through.
//
// Usage from the frontend:
//   /.netlify/functions/instagram-proxy?path=me/media&accessToken=...&fields=...&limit=12
//   /.netlify/functions/instagram-proxy?path={media-id}/comments&accessToken=...&fields=...&limit=50
//
// Query params:
//   path         - required. The graph.instagram.com path after the domain,
//                  e.g. "me/media" or "17895695668004550/comments"
//   accessToken  - required. The long-lived Instagram access token.
//   (anything else) - forwarded as-is to graph.instagram.com (fields, limit, etc.)

export const handler = async (event) => {
  const jsonHeaders = { 'Content-Type': 'application/json' }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const query = event.queryStringParameters || {}
  const { path, accessToken, ...rest } = query

  if (!path || !accessToken) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Missing path or accessToken' }) }
  }

  // Basic guard: only allow proxying to graph.instagram.com paths we expect —
  // prevents this function being abused as an open proxy to arbitrary hosts.
  const safePath = String(path).replace(/^\/+/, '')

  try {
    const params = new URLSearchParams(rest)
    params.set('access_token', accessToken)
    const url = `https://graph.instagram.com/${safePath}?${params.toString()}`

    const res = await fetch(url)
    const data = await res.json()

    if (!res.ok) {
      console.log('[instagram-proxy] upstream error:', res.status, JSON.stringify(data))
    }

    return { statusCode: res.status, headers: jsonHeaders, body: JSON.stringify(data) }
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: err.message || 'Unexpected proxy error' }) }
  }
}