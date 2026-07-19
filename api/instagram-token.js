// api/instagram-token.js
//
// FACEBOOK LOGIN FOR BUSINESS FLOW (replaces the old Instagram-Login flow).
// Reels comments are not reliably readable through graph.instagram.com
// (Instagram API with Instagram Login). This flow uses graph.facebook.com
// instead, via a Facebook Page linked to the Instagram Business account,
// which has mature support for reading Reels comments.
//
// Flow:
//   1. Frontend redirects the user to https://www.facebook.com/v23.0/dialog/oauth
//      using a config_id (from a Login Configuration created under
//      Facebook Login for Business → Configurations in the Meta App Dashboard)
//      instead of a plain `scope` param — required for business-scoped access
//      to Pages/Instagram accounts living inside a Business Portfolio.
//   2. Facebook redirects back to {VITE_APP_URL}/instagram?code=...
//   3. Frontend calls this function with { code, redirectUri }
//   4. This function:
//        a. exchanges code -> short-lived user token
//        b. exchanges short-lived -> long-lived user token (~60 days)
//        c. looks up the user's Facebook Pages and finds the one with a
//           linked Instagram Business Account
//        d. returns that Page's access token (page tokens derived from a
//           long-lived user token do not expire) plus the IG business
//           account id/username
//   5. Returns { accessToken, igUserId, username, profilePictureUrl } to the frontend
//
// Required Vercel environment variables (server-side, NOT VITE_-prefixed):
//   INSTAGRAM_APP_ID       — your Meta App ID (same app, with "Facebook Login
//                             for Business" product added)
//   INSTAGRAM_APP_SECRET   — your Meta App Secret
//
// Deployed URL on Vercel: /api/instagram-token

const GRAPH_VERSION = 'v23.0'

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

  const appId = process.env.INSTAGRAM_APP_ID
  const appSecret = process.env.INSTAGRAM_APP_SECRET
  if (!appId || !appSecret) {
    return res.status(500).json({
      error: 'Server is missing INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET env vars',
    })
  }

  console.log('[instagram-token] received redirectUri:', redirectUri)
  console.log('[instagram-token] received code (first 12 chars):', code.slice(0, 12) + '...')

  try {
    // ── Step 1: exchange the authorization code for a short-lived user token ──
    const shortParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    })
    const shortRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${shortParams.toString()}`)
    const shortData = await shortRes.json()

    console.log('[instagram-token] short-lived token response status:', shortRes.status)

    if (!shortRes.ok || !shortData.access_token) {
      const msg = shortData.error?.message || 'Failed to exchange authorization code'
      return res.status(400).json({ error: msg })
    }

    // ── Step 2: exchange for a long-lived user token (~60 days) ──
    const longParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortData.access_token,
    })
    const longRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${longParams.toString()}`)
    const longData = await longRes.json()

    if (!longRes.ok || !longData.access_token) {
      const msg = longData.error?.message || 'Failed to obtain long-lived token'
      return res.status(400).json({ error: msg })
    }

    const longLivedUserToken = longData.access_token

    // ── Step 3: find the user's Pages, and the one with a linked IG Business Account ──
    const pagesParams = new URLSearchParams({
      fields: 'name,access_token,instagram_business_account{id,username,profile_picture_url}',
      access_token: longLivedUserToken,
    })
    const pagesRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?${pagesParams.toString()}`)
    const pagesData = await pagesRes.json()

    console.log('[instagram-token] pages response:', JSON.stringify(pagesData))

    if (!pagesRes.ok) {
      const msg = pagesData.error?.message || 'Failed to fetch linked Facebook Pages'
      return res.status(400).json({ error: msg })
    }

    const pageWithIg = (pagesData.data || []).find(p => p.instagram_business_account)

    if (!pageWithIg) {
      return res.status(400).json({
        error: 'No Facebook Page with a linked Instagram Business account was found. Make sure your Instagram account is linked to a Facebook Page you manage.',
      })
    }

    const ig = pageWithIg.instagram_business_account

    return res.status(200).json({
      accessToken: pageWithIg.access_token, // Page access token — long-lived, doesn't expire on its own
      igUserId: ig.id,
      username: ig.username,
      profilePictureUrl: ig.profile_picture_url,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' })
  }
}