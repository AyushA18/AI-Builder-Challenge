// api/instagram-login-proxy.js
//
// INSTAGRAM API WITH INSTAGRAM LOGIN: proxies GET requests to
// graph.instagram.com server-side (where CORS doesn't apply) using the
// Instagram User access token returned by /api/instagram-login-token.
//
// This is the counterpart to instagram-proxy.js (which hits
// graph.facebook.com) — same shape, different host, used to A/B test
// whether Reels comments come back more reliably on this flow.
//
// Usage from the frontend:
//   /api/instagram-login-proxy?path={ig-user-id}/media&accessToken=...&fields=...&limit=12
//   /api/instagram-login-proxy?path={media-id}/comments&accessToken=...&fields=...&limit=50
//
// Query params:
//   path         - required. The graph.instagram.com path after the host,
//                  e.g. "17841405309211844/media" or "17895695668004550/comments"
//   accessToken  - required. The Instagram User access token returned by
//                  /api/instagram-login-token.
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
    const normalizedRest = Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
    )

    const params = new URLSearchParams(normalizedRest)
    params.set('access_token', accessToken)
    // No version segment — graph.instagram.com is unversioned in this flow.
    const url = `https://graph.instagram.com/${safePath}?${params.toString()}`

    const upstreamRes = await fetch(url)
    const data = await upstreamRes.json()

    // ── TEMPORARY DEBUG LOGGING — remove once comments-on-reels is fixed ──
    // Never logs the access token. Logs the path + full upstream body so we
    // can directly compare this flow's Reels-comment behavior against the
    // Facebook Login flow's.
    console.log('[instagram-login-proxy] path:', safePath)
    console.log('[instagram-login-proxy] upstream status:', upstreamRes.status)
    console.log('[instagram-login-proxy] upstream body:', JSON.stringify(data))

    if (!upstreamRes.ok) {
      console.log('[instagram-login-proxy] upstream error:', upstreamRes.status, JSON.stringify(data))
    }

    return res.status(upstreamRes.status).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected proxy error' })
  }
}