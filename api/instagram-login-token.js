// api/instagram-login-token.js
//
// INSTAGRAM API WITH INSTAGRAM LOGIN (aka "Business Login for Instagram").
// No Facebook Page required — the user authenticates directly with Instagram.
// Uses api.instagram.com for the code exchange and graph.instagram.com for
// everything after. This is the flow being A/B tested against the Facebook
// Login for Business flow (instagram-token.js) for Reels comment reliability.
//
// Flow:
//   1. Frontend redirects the user to https://www.instagram.com/oauth/authorize
//   2. Instagram redirects back to {VITE_APP_URL}/instagram?code=...
//   3. Frontend calls this function with { code, redirectUri }
//   4. This function:
//        a. exchanges code -> short-lived Instagram User access token (1hr),
//           which also returns the Instagram-scoped user_id directly — no
//           Facebook Page lookup needed
//        b. exchanges short-lived -> long-lived token (60 days)
//        c. fetches username / profile picture via graph.instagram.com/me
//   5. Returns { accessToken, igUserId, username, profilePictureUrl } to the
//      frontend — SAME shape as instagram-token.js, so the frontend code
//      that consumes this doesn't need to change.
//
// Required Vercel environment variables (server-side, NOT VITE_-prefixed):
//   INSTAGRAM_LOGIN_APP_ID       — the "Instagram App ID" shown on the
//                                   Instagram product's "API setup with
//                                   Instagram business login" page.
//                                   THIS IS A DIFFERENT NUMBER than your main
//                                   Meta App ID used for Facebook Login.
//   INSTAGRAM_LOGIN_APP_SECRET   — the matching "Instagram App Secret" from
//                                   that same page (also different from your
//                                   main Meta App Secret).
//
// Deployed URL on Vercel: /api/instagram-login-token

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let payload = req.body
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

  const appId = process.env.INSTAGRAM_LOGIN_APP_ID
  const appSecret = process.env.INSTAGRAM_LOGIN_APP_SECRET
  if (!appId || !appSecret) {
    return res.status(500).json({
      error: 'Server is missing INSTAGRAM_LOGIN_APP_ID / INSTAGRAM_LOGIN_APP_SECRET env vars',
    })
  }

  console.log('[instagram-login-token] received redirectUri:', redirectUri)
  console.log('[instagram-login-token] received code (first 12 chars):', code.slice(0, 12) + '...')

  try {
    // ── Step 1: exchange the authorization code for a short-lived token ──
    // Note: this endpoint wants a FORM POST body, not query params.
    const shortForm = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    })
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: shortForm.toString(),
    })
    const shortData = await shortRes.json()

    console.log('[instagram-login-token] short-lived token response status:', shortRes.status)

    if (!shortRes.ok || !shortData.access_token) {
      const msg = shortData.error_message || shortData.error?.message || 'Failed to exchange authorization code'
      return res.status(400).json({ error: msg })
    }

    const shortLivedToken = shortData.access_token
    const igUserId = shortData.user_id // Instagram-scoped user ID — no Page lookup needed

    // ── Step 2: exchange for a long-lived token (~60 days) ──
    const longParams = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: appSecret,
      access_token: shortLivedToken,
    })
    const longRes = await fetch(`https://graph.instagram.com/access_token?${longParams.toString()}`)
    const longData = await longRes.json()

    if (!longRes.ok || !longData.access_token) {
      const msg = longData.error_message || longData.error?.message || 'Failed to obtain long-lived token'
      return res.status(400).json({ error: msg })
    }

    const longLivedToken = longData.access_token

    // ── Step 3: fetch username + profile picture ──
    const profileParams = new URLSearchParams({
      fields: 'user_id,username,profile_picture_url',
      access_token: longLivedToken,
    })
    const profileRes = await fetch(`https://graph.instagram.com/me?${profileParams.toString()}`)
    const profileData = await profileRes.json()

    console.log('[instagram-login-token] profile response:', JSON.stringify(profileData))

    if (!profileRes.ok) {
      const msg = profileData.error_message || profileData.error?.message || 'Failed to fetch Instagram profile'
      return res.status(400).json({ error: msg })
    }

    return res.status(200).json({
      accessToken: longLivedToken,
      igUserId: profileData.user_id || igUserId,
      username: profileData.username,
      profilePictureUrl: profileData.profile_picture_url,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' })
  }
}