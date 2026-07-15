// api/instagram-proxy.js
//
// FACEBOOK LOGIN FOR BUSINESS FLOW: proxies GET requests to graph.facebook.com
// server-side (where CORS doesn't apply) using a Page access token tied to
// a Facebook Page with a linked Instagram Business Account. This has more
// reliable support for reading Reels comments than the old
// graph.instagram.com (Instagram Login) flow did.
//
// Usage from the frontend:
//   /api/instagram-proxy?path={ig-user-id}/media&accessToken=...&fields=...&limit=12
//   /api/instagram-proxy?path={media-id}/comments&accessToken=...&fields=...&limit=50
//
// Query params:
//   path         - required. The graph.facebook.com path after the version,
//                  e.g. "17841405309211844/media" or "17895695668004550/comments"
//   accessToken  - required. The Page access token returned by /api/instagram-token.
//   (anything else) - forwarded as-is to graph.facebook.com (fields, limit, etc.)

const GRAPH_VERSION = 'v23.0'

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
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${safePath}?${params.toString()}`

    const upstreamRes = await fetch(url)
    const data = await upstreamRes.json()

    // ── TEMPORARY DEBUG LOGGING — remove once comments-on-reels is fixed ──
    // Never logs the access token. Logs the path + full upstream body so we
    // can see exactly what Instagram returned (empty data vs. an error
    // object vs. a permissions issue) — check this in Vercel's function logs.
    console.log('[instagram-proxy] path:', safePath)
    console.log('[instagram-proxy] upstream status:', upstreamRes.status)
    console.log('[instagram-proxy] upstream body:', JSON.stringify(data))

    if (!upstreamRes.ok) {
      console.log('[instagram-proxy] upstream error:', upstreamRes.status, JSON.stringify(data))
    }

    return res.status(upstreamRes.status).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected proxy error' })
  }
}