// src/utils/googleCalendar.js
//
// Client-side "Add to Google Calendar" helper using Google Identity Services (GIS).
// No backend / OAuth code exchange needed — GIS's token client gets a short-lived
// access token directly in the browser via a popup consent screen, and the
// Calendar API accepts that token straight from fetch() (Google's REST APIs
// support CORS with a Bearer token, unlike the Facebook Graph API used
// elsewhere in this project).
//
// Scope is the minimal one for this feature: calendar.events (create/edit
// events only — cannot read the rest of the user's calendar).
//
// Required env var (Vite):
//   VITE_GOOGLE_CLIENT_ID — OAuth 2.0 Client ID (Web application) from
//   Google Cloud Console > APIs & Services > Credentials.
//
// See GOOGLE_CALENDAR_SETUP.md for how to create that client ID.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const SCOPE = 'https://www.googleapis.com/auth/calendar.events'

let tokenClient = null
let cachedToken = null // { access_token, expires_at }
let gisLoadPromise = null

// Loads the GIS script if it isn't already on the page (safe to call even if
// you've also added the <script> tag to index.html — it'll just resolve immediately).
function loadGisScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (gisLoadPromise) return gisLoadPromise

  gisLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]')
    if (existing) {
      existing.addEventListener('load', resolve)
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
  return gisLoadPromise
}

// Returns a valid access token, prompting the Google consent popup only if we
// don't already have a cached, unexpired one from earlier in this session.
export async function getGoogleAccessToken() {
  if (!CLIENT_ID) {
    throw new Error('Missing VITE_GOOGLE_CLIENT_ID — see GOOGLE_CALENDAR_SETUP.md')
  }

  if (cachedToken && cachedToken.expires_at > Date.now() + 30_000) {
    return cachedToken.access_token
  }

  await loadGisScript()

  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: () => {}, // replaced per-request below
      })
    }

    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error))
        return
      }
      cachedToken = {
        access_token: resp.access_token,
        expires_at: Date.now() + (resp.expires_in || 3600) * 1000,
      }
      resolve(cachedToken.access_token)
    }

    tokenClient.error_callback = (err) => {
      reject(new Error(err?.message || 'Google sign-in was cancelled or failed'))
    }

    // Only force the consent screen on the very first request in this session;
    // GIS silently reuses the grant for subsequent token requests after that.
    tokenClient.requestAccessToken({ prompt: cachedToken ? '' : 'consent' })
  })
}

// Creates a single event on the user's primary Google Calendar.
// start/end are JS Date objects. Pass allDay: true for a date-only event
// (useful since content-idea "post on this day" doesn't need a specific time).
export async function createCalendarEvent({ title, description, start, end, allDay = false }) {
  const accessToken = await getGoogleAccessToken()

  const body = { summary: title, description }

  if (allDay) {
    const toDateStr = (d) => d.toISOString().slice(0, 10)
    body.start = { date: toDateStr(start) }
    body.end = { date: toDateStr(end || start) }
  } else {
    body.start = { dateTime: start.toISOString() }
    body.end = { dateTime: (end || new Date(start.getTime() + 60 * 60 * 1000)).toISOString() }
  }

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Calendar API error (${res.status})`)
  }

  return res.json() // includes htmlLink to the created event
}