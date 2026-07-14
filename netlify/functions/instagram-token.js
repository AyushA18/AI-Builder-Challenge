// netlify/functions/instagram-token.js
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
// Required Netlify environment variables (server-side, NOT VITE_-prefixed):
//   INSTAGRAM_APP_ID
//   INSTAGRAM_APP_SECRET

export const handler = async (event) => {
  const jsonHeaders = { 'Content-Type': 'application/json' }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { code, redirectUri } = payload
  if (!code || !redirectUri) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Missing code or redirectUri' }) }
  }

  const appId = process.env.INSTAGRAM_APP_ID
  const appSecret = process.env.INSTAGRAM_APP_SECRET
  if (!appId || !appSecret) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'Server is missing INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET env vars' }),
    }
  }

  try {
    // ── Step 1: exchange the authorization code for a short-lived token ──
    const form = new URLSearchParams()
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

    if (!shortRes.ok || !shortData.access_token) {
      const msg = shortData.error_message || shortData.error_description || 'Failed to exchange authorization code'
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: msg }) }
    }

    const { access_token: shortLivedToken, user_id: userId } = shortData

    // ── Step 2: exchange the short-lived token for a long-lived token (60 days) ──
    const longUrl = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortLivedToken)}`
    const longRes = await fetch(longUrl)
    const longData = await longRes.json()

    if (!longRes.ok || !longData.access_token) {
      const msg = longData.error?.message || 'Failed to obtain long-lived token'
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: msg }) }
    }

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        accessToken: longData.access_token,
        expiresIn: longData.expires_in, // seconds, ~5184000 (60 days)
        userId,
      }),
    }
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: err.message || 'Unexpected server error' }) }
  }
}