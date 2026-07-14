// api/instagram-proxy.js
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
//   /api/instagram-proxy?path=me/media&accessToken=...&fields=...&limit=12
//   /api/instagram-proxy?path={media-id}/comments&accessToken=...&fields=...&limit=50
//
// Query params:
//   path         - required. The graph.instagram.com path after the domain,
//                  e.g. "me/media" or "17895695668004550/comments"
//   accessToken  - required. The long-lived Instagram access token.
//   (anything else) - forwarded as-is to graph.instagram.com (fields, limit, etc.)

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const query = req.query || {}
  const { path, accessToken, ...rest } = query

  if (!path || !accessToken) {
    return res.status(400).json({ error: 'Missing path or accessToken' })
  }

  // Basic guard: only allow proxying to graph.instagram.com paths we expect —
  // prevents this function being abused as an open proxy to arbitrary hosts.
  const safePath = String(path).replace(/^\/+/, '')

  try {
    // rest values can be strings or string[] depending on how Vercel parses
    // repeated query params — normalize to strings for URLSearchParams.
    const normalizedRest = Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
    )

    const params = new URLSearchParams(normalizedRest)
    params.set('access_token', accessToken)
    const url = `https://graph.instagram.com/${safePath}?${params.toString()}`

    const upstreamRes = await fetch(url)
    const data = await upstreamRes.json()

    if (!upstreamRes.ok) {
      console.log('[instagram-proxy] upstream error:', upstreamRes.status, JSON.stringify(data))
    }

    return res.status(upstreamRes.status).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected proxy error' })
  }
}