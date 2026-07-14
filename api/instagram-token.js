// api/instagram-token.js
//
// Exchanges an Instagram OAuth "authorization code" for a long-lived (60-day)
// access token. This MUST run server-side because it needs INSTAGRAM_APP_SECRET,
// which should never be exposed to the browser.
//
// Flow:
//   1. Frontend redirects the user to https://www.instagram.com/oauth/authorize
//   2. Instagram redirects back to {VITE_APP_URL}/instagram?code=...
//   3. Frontend calls this function with { code, redirectUri }
//   4. This function exchanges code -> short-lived token -> long-lived token
//   5. Returns { accessToken, expiresIn, userId } to the frontend
//
// Required Vercel environment variables (server-side, NOT VITE_-prefixed):
//   INSTAGRAM_APP_ID
//   INSTAGRAM_APP_SECRET
//
// Deployed URL on Vercel: /api/instagram-token

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let payload = req.body
  // Vercel usually parses JSON bodies automatically, but guard in case
  // it arrives as a raw string.
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}')
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' })
    }
  }
  payload = payload || {}

  const { code, redirectUri } = payload
  if (!code || !redirectUri) {
    return res.status(400).json({ error: 'Missing code or redirectUri' })
  }

  const appId = process.env.INSTAGRAM_APP_ID
  const appSecret = process.env.INSTAGRAM_APP_SECRET
  if (!appId || !appSecret) {
    return res.status(500).json({
      error: 'Server is missing INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET env vars',
    })
  }

  // ── TEMPORARY DEBUG LOGGING — remove once the flow works ──
  // Safe to leave client_id visible; NEVER logs the secret itself, only its length,
  // which is enough to catch a common copy-paste mistake (extra whitespace/newline).
  console.log('[instagram-token] received redirectUri:', redirectUri)
  console.log('[instagram-token] received code (first 12 chars):', code.slice(0, 12) + '...')
  console.log('[instagram-token] using INSTAGRAM_APP_ID:', appId)
  console.log('[instagram-token] INSTAGRAM_APP_SECRET length:', appSecret.length, '(trimmed:', appSecret.trim().length, ')')

  try {
    // ── Step 1: exchange the authorization code for a short-lived token ──
    // IMPORTANT: Instagram's oauth/access_token endpoint expects
    // multipart/form-data, NOT application/x-www-form-urlencoded.
    // Using URLSearchParams here sends the wrong content type and can
    // produce misleading errors (including a bogus "redirect_uri" complaint
    // even when the redirect_uri is correct). FormData makes fetch set the
    // correct multipart Content-Type with boundary automatically.
    const form = new FormData()
    form.append('client_id', appId)
    form.append('client_secret', appSecret)
    form.append('grant_type', 'authorization_code')
    form.append('redirect_uri', redirectUri)
    form.append('code', code)

    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: form,
    })
    const shortData = await shortRes.json()

    console.log('[instagram-token] Meta short-lived token response status:', shortRes.status)
    console.log('[instagram-token] Meta short-lived token response body:', JSON.stringify(shortData))

    if (!shortRes.ok || !shortData.access_token) {
      const msg = shortData.error_message || shortData.error_description || 'Failed to exchange authorization code'
      return res.status(400).json({ error: msg })
    }

    const { access_token: shortLivedToken, user_id: userId } = shortData

    // ── Step 2: exchange the short-lived token for a long-lived token (60 days) ──
    const longUrl = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortLivedToken)}`
    const longRes = await fetch(longUrl)
    const longData = await longRes.json()

    if (!longRes.ok || !longData.access_token) {
      const msg = longData.error?.message || 'Failed to obtain long-lived token'
      return res.status(400).json({ error: msg })
    }

    return res.status(200).json({
      accessToken: longData.access_token,
      expiresIn: longData.expires_in, // seconds, ~5184000 (60 days)
      userId,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' })
  }
}