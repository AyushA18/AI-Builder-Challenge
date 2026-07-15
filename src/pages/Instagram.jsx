import { useState, useRef, useEffect } from 'react'
import { jsPDF } from 'jspdf'

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const DEFAULT_GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY
const IG_APP_ID = import.meta.env.VITE_INSTAGRAM_APP_ID
const APP_URL = (import.meta.env.VITE_APP_URL || window.location.origin).replace(/\/$/, '')
const REDIRECT_URI = `${APP_URL}/instagram`
const GROQ_MODEL = 'llama-3.3-70b-versatile'
// Facebook Login for Business scopes — replaces the old Instagram Login scopes.
// pages_show_list / pages_read_engagement let us find the Page + linked IG account;
// instagram_basic / instagram_manage_comments let us read media and comments.
const IG_SCOPES = 'pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_comments'
const FB_OAUTH_VERSION = 'v23.0'

const MAX_COMMENTS = 50
const LS_GROQ = 'pixelforge_groq_key'          // shared with Analyzer.jsx — same key
const SS_IG_TOKEN = 'pixelforge_ig_token'      // sessionStorage — cleared when tab closes
const SS_IG_USER_ID = 'pixelforge_ig_user_id'  // the Instagram Business Account id
const SS_IG_PROFILE = 'pixelforge_ig_profile'  // cached { username, profile_picture_url }

// ─── HELPERS: FACEBOOK OAUTH (for Instagram Business access) ────────────────
function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: IG_APP_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: IG_SCOPES,
  })
  return `https://www.facebook.com/${FB_OAUTH_VERSION}/dialog/oauth?${params.toString()}`
}

async function exchangeCodeForToken(code) {
  const res = await fetch('/api/instagram-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri: REDIRECT_URI }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to connect Instagram account')
  return data // { accessToken, igUserId, username, profilePictureUrl }
}

// ─── HELPERS: INSTAGRAM GRAPH API ────────────────────────────────────────────
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count'

async function fetchRecentMedia(igUserId, accessToken) {
  const params = new URLSearchParams({ path: `${igUserId}/media`, accessToken, fields: MEDIA_FIELDS, limit: '12' })
  const res = await fetch(`/api/instagram-proxy?${params.toString()}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || 'Failed to fetch your recent posts')
  }
  return data.data || []
}

async function fetchPostComments(mediaId, accessToken) {
  const fields = 'text,username,timestamp,like_count'
  const params = new URLSearchParams({ path: `${mediaId}/comments`, accessToken, fields, limit: String(MAX_COMMENTS) })
  const res = await fetch(`/api/instagram-proxy?${params.toString()}`)
  const data = await res.json().catch(() => ({}))

  // ── TEMPORARY DEBUG LOGGING — remove once comments-on-reels is fixed ──
  console.log('[fetchPostComments] mediaId:', mediaId)
  console.log('[fetchPostComments] response status ok:', res.ok, res.status)
  console.log('[fetchPostComments] raw response:', data)

  if (!res.ok) {
    throw new Error(data.error?.message || data.error || 'Failed to fetch comments for this post')
  }
  return (data.data || []).map(c => ({
    author: c.username || 'unknown',
    text: c.text || '',
    likes: c.like_count || 0,
  }))
}

// ─── HELPERS: GROQ (identical retry/parse logic to Analyzer.jsx) ────────────
function parseRetryAfterMs(message = '') {
  const m = message.match(/try again in ([0-9.]+)s/i)
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null
}

async function callGroq(apiKey, messages, maxTokens = 1500) {
  const MAX_RETRIES = 6
  let attempt = 0

  while (true) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.3, max_tokens: maxTokens }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const msg = err.error?.message || `Groq API error (${res.status})`
      if (res.status === 429 && attempt < MAX_RETRIES) {
        attempt++
        const groqWaitMs = parseRetryAfterMs(msg)
        const waitMs = groqWaitMs ? groqWaitMs + 500 : 2000 * attempt
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      const e = new Error(msg)
      e.status = res.status
      throw e
    }

    const data = await res.json()
    const raw = data.choices[0].message.content.trim()
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  }
}

function buildAnalysisPrompt(comments) {
  const commentText = comments
    .map((c, i) => `[${i + 1}] @${c.author} (👍${c.likes}): ${c.text.slice(0, 100)}`)
    .join('\n')

  return `Analyze these ${comments.length} Instagram post comments and produce a complete report.

COMMENTS:
${commentText}

Return ONLY valid JSON, no markdown, no explanation:
{
  "sentimentSummary": "<one sentence overall vibe>",
  "sentiment": {"positive": <0-100>, "neutral": <0-100>, "negative": <0-100>},
  "topQuestions": [{"question": "...", "frequency": "..."}],
  "painPoints": [{"point": "...", "mentions": "..."}],
  "contentIdeas": [{"idea": "...", "basis": "..."}],
  "audiencePhrases": ["..."],
  "nextVideoIdeas": [{"title": "...", "reason": "..."}],
  "topComment": {"author": "...", "text": "...", "likes": <number>, "whyItResonated": "..."},
  "toxicComments": [{"author": "...", "text": "...", "reason": "..."}]
}
(topQuestions: up to 5, painPoints: up to 3, contentIdeas: up to 5, audiencePhrases: up to 6, nextVideoIdeas: up to 3, toxicComments: up to 5. Sentiment must sum to 100. "nextVideoIdeas" means next post/content ideas for this creator.)`
}

async function analyzeAllComments(comments, apiKey, onProgress) {
  onProgress?.({ phase: 'analyzing', totalComments: comments.length })
  const result = await callGroq(apiKey, [{ role: 'user', content: buildAnalysisPrompt(comments) }], 1500)

  return {
    sentiment: {
      positive: result.sentiment?.positive ?? 0,
      neutral:  result.sentiment?.neutral  ?? 0,
      negative: result.sentiment?.negative ?? 0,
      summary:  result.sentimentSummary    ?? '',
    },
    topQuestions:    result.topQuestions    ?? [],
    painPoints:      result.painPoints      ?? [],
    contentIdeas:    result.contentIdeas    ?? [],
    audiencePhrases: result.audiencePhrases ?? [],
    nextVideoIdeas:  result.nextVideoIdeas  ?? [],
    topComment: {
      author:         result.topComment?.author        ?? 'unknown',
      text:           result.topComment?.text          ?? '',
      likes:          result.topComment?.likes         ?? 0,
      whyItResonated: result.topComment?.whyItResonated ?? '',
    },
    toxicComments: result.toxicComments ?? [],
  }
}

// ─── HELPERS: PDF DOWNLOAD (same layout as Analyzer.jsx) ────────────────────
function downloadPdfReport(report, meta) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 48
  const maxWidth = pageWidth - margin * 2
  let y = 56

  function checkPageBreak(need = 16) {
    if (y + need > pageHeight - margin) { doc.addPage(); y = 56 }
  }
  function addTitle(text) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(20, 20, 20)
    doc.text(text, margin, y); y += 26
  }
  function addMeta(text) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(110, 110, 110)
    doc.text(text, margin, y); y += 14
  }
  function addHeading(text) {
    y += 8; checkPageBreak(28)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(216, 90, 48)
    doc.text(text, margin, y); y += 18
  }
  function addBody(text, { bold = false, indent = 0 } = {}) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(11); doc.setTextColor(40, 40, 40)
    const lines = doc.splitTextToSize(text, maxWidth - indent)
    for (const line of lines) { checkPageBreak(16); doc.text(line, margin + indent, y); y += 15 }
    y += 4
  }

  addTitle('Instagram Comment Intelligence Report')
  addMeta(`Post: ${meta.postUrl}`)
  addMeta(`Comments analyzed: ${meta.commentCount}`)
  addMeta(`Generated: ${meta.generatedAt}`)

  addHeading('Overall Sentiment')
  addBody(report.sentiment.summary)
  addBody(`Positive: ${report.sentiment.positive}%   Neutral: ${report.sentiment.neutral}%   Negative: ${report.sentiment.negative}%`)

  addHeading('Most Resonant Comment')
  addBody(`@${report.topComment.author} (${report.topComment.likes} likes)`, { bold: true })
  addBody(`"${report.topComment.text}"`)
  addBody(`Why it resonated: ${report.topComment.whyItResonated}`)

  addHeading('Top Questions')
  report.topQuestions.forEach((q, i) => addBody(`${i + 1}. ${q.question}  (${q.frequency})`))

  addHeading('Pain Points')
  report.painPoints.forEach(p => addBody(`- ${p.point}  (${p.mentions})`))

  addHeading('Content Ideas')
  report.contentIdeas.forEach((c, i) => { addBody(`${i + 1}. ${c.idea}`, { bold: true }); addBody(`From: ${c.basis}`, { indent: 14 }) })

  addHeading('Suggested Next Content Ideas')
  report.nextVideoIdeas.forEach((v, i) => { addBody(`${i + 1}. ${v.title}`, { bold: true }); addBody(v.reason, { indent: 14 }) })

  addHeading('Audience Phrases')
  addBody(report.audiencePhrases.join(', '))

  if (report.toxicComments?.length) {
    addHeading('Flagged Comments')
    report.toxicComments.forEach(t => addBody(`@${t.author}: "${t.text}" — ${t.reason}`))
  }

  doc.save(`instagram-comment-report-${Date.now()}.pdf`)
}

// ─── SHARED UI (same look as Analyzer.jsx) ──────────────────────────────────
function Card({ children, style = {} }) {
  return <div style={{ background: '#1A1815', border: '1px solid #2E2820', borderRadius: 14, padding: '24px', ...style }}>{children}</div>
}
function SectionTitle({ icon, title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <span style={{ fontWeight: 700, fontSize: 15, color: '#F0EBE3' }}>{title}</span>
    </div>
  )
}
function SentimentBar({ label, value, color }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: '#7A7268' }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}%</span>
      </div>
      <div style={{ background: '#2E2820', borderRadius: 999, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 999, transition: 'width 1s ease' }} />
      </div>
    </div>
  )
}
function Tag({ children }) {
  return <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 999, background: '#242018', border: '1px solid #2E2820', fontSize: 12, color: '#EF9F27', fontWeight: 500, margin: '3px' }}>{children}</span>
}
function StepBadge({ n }) {
  return <div style={{ width: 28, height: 28, borderRadius: 999, flexShrink: 0, background: 'linear-gradient(135deg,#D85A30,#EF9F27)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff' }}>{n}</div>
}
function LoadingPulse({ message }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <div style={{ fontSize: 48, marginBottom: 20, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>📸</div>
      <p style={{ color: '#EF9F27', fontWeight: 600, fontSize: 16 }}>{message}</p>
      <p style={{ color: '#7A7268', fontSize: 13, marginTop: 8 }}>Analyzing up to {MAX_COMMENTS} comments…</p>
      <style>{`@keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }`}</style>
    </div>
  )
}

// ─── SETTINGS (shared BYO Groq key — same localStorage key as Analyzer.jsx) ─
function SettingsPanel({ groqKey, onSave }) {
  const [open, setOpen] = useState(false)
  const [g, setG] = useState(groqKey)
  const usingOwnGroq = !!groqKey.trim()

  useEffect(() => { setG(groqKey) }, [groqKey])

  const inputStyle = {
    width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #2E2820',
    background: '#0F0E0C', color: '#F0EBE3', fontSize: 13, outline: 'none',
    fontFamily: 'JetBrains Mono, monospace', marginTop: 6, marginBottom: 14,
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid #2E2820', borderRadius: 8, padding: '8px 14px', color: '#7A7268', fontSize: 13, fontWeight: 600 }}>
        ⚙️ API Settings
        {usingOwnGroq && <span style={{ color: '#4CAF7D', fontSize: 11, background: '#12251A', padding: '2px 8px', borderRadius: 999 }}>using your key</span>}
      </button>
      {open && (
        <Card style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, color: '#7A7268', marginBottom: 16, lineHeight: 1.6 }}>
            Optional — bring your own Groq API key instead of the shared demo key. It's saved only in your
            browser and shared with the YouTube Analyzer page too. Leave blank to keep using the default.
          </p>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#F0EBE3' }}>Your Groq API key</label>
          <input type="password" value={g} onChange={e => setG(e.target.value)} placeholder="Enter your API key..." style={inputStyle} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => { onSave(g.trim()); setOpen(false) }} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#D85A30,#EF9F27)', color: '#fff', fontWeight: 700, fontSize: 13 }}>Save</button>
            <button onClick={() => { setG(''); onSave('') }} style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #2E2820', background: 'transparent', color: '#7A7268', fontWeight: 600, fontSize: 13 }}>Clear / use default</button>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── CONNECT SCREEN ──────────────────────────────────────────────────────────
function ConnectScreen({ onConnect, connecting, error }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '60px 20px' }}>
      <div style={{ fontSize: 52, marginBottom: 20 }}>📷</div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: '#F0EBE3', marginBottom: 10 }}>Connect your Instagram account</h2>
      <p style={{ color: '#7A7268', fontSize: 14, maxWidth: 420, lineHeight: 1.7, marginBottom: 28 }}>
        Log in with your Instagram Business or Creator account to pull your recent posts and analyze the comments.
        No Facebook Page required.
      </p>
      <button
        onClick={onConnect}
        disabled={connecting}
        style={{
          padding: '14px 32px', borderRadius: 10, border: 'none',
          background: 'linear-gradient(135deg, #D85A30, #EF9F27)',
          color: '#fff', fontWeight: 700, fontSize: 15,
          boxShadow: '0 4px 20px rgba(216,90,48,0.35)',
          opacity: connecting ? 0.7 : 1,
        }}
      >
        {connecting ? 'Connecting…' : 'Connect with Instagram →'}
      </button>
      {error && (
        <p style={{ marginTop: 20, fontSize: 13, color: '#E05252', background: '#1A0E0E', padding: '10px 14px', borderRadius: 8, border: '1px solid #3A1515', maxWidth: 420 }}>
          ⚠️ {error}
        </p>
      )}
    </div>
  )
}

// ─── POST GRID ────────────────────────────────────────────────────────────────
function PostGrid({ posts, profile, onSelect, onDisconnect }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: '#F0EBE3' }}>Pick a post to analyze</h2>
          {profile?.username && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              {profile.profile_picture_url && (
                <img src={profile.profile_picture_url} alt="" style={{ width: 22, height: 22, borderRadius: 999, objectFit: 'cover' }} />
              )}
              <span style={{ fontSize: 13, color: '#7A7268' }}>
                Connected as <span style={{ color: '#EF9F27', fontWeight: 600 }}>@{profile.username}</span>
              </span>
            </div>
          )}
        </div>
        <button onClick={onDisconnect} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #2E2820', background: 'transparent', color: '#7A7268', fontSize: 13, fontWeight: 600 }}>
          Disconnect
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
        {posts.map(post => {
          const thumb = post.media_type === 'VIDEO' ? post.thumbnail_url : post.media_url
          return (
            <button
              key={post.id}
              onClick={() => onSelect(post)}
              style={{
                textAlign: 'left', background: '#1A1815', border: '1px solid #2E2820',
                borderRadius: 12, overflow: 'hidden', padding: 0,
              }}
            >
              <div style={{ width: '100%', aspectRatio: '1/1', background: '#0F0E0C', overflow: 'hidden' }}>
                {thumb && <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ padding: '10px 12px' }}>
                <p style={{ fontSize: 12, color: '#F0EBE3', lineHeight: 1.4, marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {post.caption || '(no caption)'}
                </p>
                <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#7A7268' }}>
                  <span>💬 {post.comments_count ?? 0}</span>
                  <span>❤️ {post.like_count ?? 0}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      {posts.length === 0 && (
        <p style={{ color: '#7A7268', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
          No recent posts found on this account.
        </p>
      )}
    </div>
  )
}

// ─── CHATBOT (same logic as Analyzer.jsx, wording adjusted) ─────────────────
function sampleChatComments(comments, max = 50) {
  if (comments.length <= max) return comments
  const sorted = [...comments].sort((a, b) => (b.likes || 0) - (a.likes || 0))
  const top = sorted.slice(0, 10)
  const rest = sorted.slice(10)
  const candidates = rest.filter(c => c.text.length <= 120 || (c.likes || 0) >= 2)
  const needed = max - top.length
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  return [...top, ...candidates.slice(0, needed)]
}

function ChatBot({ comments, report, apiKey, postUrl }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const bottomRef = useRef(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send() {
    if (!input.trim() || loading) return
    if (!apiKey) { setChatError('No Groq API key available for chat.'); return }
    setChatError('')
    const userMsg = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    try {
      const sample = sampleChatComments(comments, 50)
      const commentCorpus = sample.map(c => `@${c.author} (👍${c.likes}): ${c.text.slice(0, 120)}`).join('\n')

      const systemPrompt = `You are a helpful assistant answering questions about the comments on an Instagram post (${postUrl}). You have an analysis report and a sample of ${sample.length} representative comments (selected from ${comments.length} total) below. Answer the user's question directly and concisely, referencing specific commenters where useful. If the comments don't cover something, say so honestly rather than guessing.

ANALYSIS REPORT SUMMARY:
${JSON.stringify({ sentiment: report.sentiment, topQuestions: report.topQuestions, painPoints: report.painPoints, contentIdeas: report.contentIdeas })}

COMMENTS SAMPLE:
${commentCorpus}`

      const MAX_RETRIES = 6
      let attempt = 0
      let reply = null

      while (reply === null) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'system', content: systemPrompt }, ...newMessages], temperature: 0.4, max_tokens: 600 }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          const msg = err.error?.message || 'Chat request failed'
          if (res.status === 429 && attempt < MAX_RETRIES) {
            attempt++
            const waitMs = (parseRetryAfterMs(msg) ?? 2000 * attempt) + 500
            await new Promise(r => setTimeout(r, waitMs))
            continue
          }
          throw new Error(msg)
        }
        const json = await res.json()
        reply = json.choices[0].message.content.trim()
      }
      setMessages(m => [...m, { role: 'assistant', content: reply }])
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', content: `⚠️ ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <SectionTitle icon="🤖" title="Ask Questions About These Comments" />
      <div style={{ maxHeight: 520, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        {messages.length === 0 && <p style={{ fontSize: 13, color: '#7A7268' }}>Try: "What do people want next?" or "Are there recurring complaints?"</p>}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: '10px 14px', borderRadius: 10, background: m.role === 'user' ? 'linear-gradient(135deg,#D85A30,#EF9F27)' : '#0F0E0C', color: m.role === 'user' ? '#fff' : '#F0EBE3', border: m.role === 'user' ? 'none' : '1px solid #2E2820', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {m.content}
          </div>
        ))}
        {loading && <div style={{ fontSize: 12, color: '#7A7268' }}>Thinking…</div>}
        <div ref={bottomRef} />
      </div>
      {chatError && <p style={{ fontSize: 12, color: '#E05252', marginBottom: 10 }}>⚠️ {chatError}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Ask a question about the comments..." style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid #2E2820', background: '#0F0E0C', color: '#F0EBE3', fontSize: 13, outline: 'none' }} />
        <button onClick={send} disabled={loading || !input.trim()} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: input.trim() ? 'linear-gradient(135deg,#D85A30,#EF9F27)' : '#2E2820', color: input.trim() ? '#fff' : '#7A7268', fontWeight: 700, fontSize: 13 }}>Ask</button>
      </div>
    </Card>
  )
}

// ─── REPORT (identical layout to Analyzer.jsx) ──────────────────────────────
function Report({ data, commentCount }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ background: 'linear-gradient(135deg, #1E1510, #1A1815)', border: '1px solid #3A2818', borderRadius: 14, padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: '#EF9F27', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Comment Intelligence Report</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#F0EBE3' }}>Analysis Complete</div>
          <div style={{ fontSize: 13, color: '#7A7268', marginTop: 4 }}>Based on {commentCount} comments</div>
        </div>
        <div style={{ background: '#0F0E0C', border: '1px solid #2E2820', borderRadius: 10, padding: '12px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#EF9F27' }}>{commentCount}</div>
          <div style={{ fontSize: 11, color: '#7A7268' }}>Comments Analyzed</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card>
          <SectionTitle icon="💬" title="Overall Sentiment" />
          <p style={{ fontSize: 13, color: '#7A7268', marginBottom: 18, lineHeight: 1.6 }}>{data.sentiment.summary}</p>
          <SentimentBar label="Positive" value={data.sentiment.positive} color="#4CAF7D" />
          <SentimentBar label="Neutral" value={data.sentiment.neutral} color="#EF9F27" />
          <SentimentBar label="Negative" value={data.sentiment.negative} color="#E05252" />
        </Card>
        <Card>
          <SectionTitle icon="🔥" title="Most Resonant Comment" />
          <div style={{ background: '#0F0E0C', borderRadius: 10, padding: '14px', border: '1px solid #2E2820', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#EF9F27', fontWeight: 600, marginBottom: 6 }}>@{data.topComment.author} · ❤️ {data.topComment.likes}</div>
            <p style={{ fontSize: 13, color: '#F0EBE3', lineHeight: 1.6 }}>"{data.topComment.text}"</p>
          </div>
          <p style={{ fontSize: 12, color: '#7A7268', lineHeight: 1.6 }}><span style={{ color: '#EF9F27', fontWeight: 600 }}>Why it resonated: </span>{data.topComment.whyItResonated}</p>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card>
          <SectionTitle icon="❓" title="Top Questions Your Audience is Asking" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.topQuestions.map((q, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <StepBadge n={i + 1} />
                <div><p style={{ fontSize: 13, color: '#F0EBE3', lineHeight: 1.5 }}>{q.question}</p><p style={{ fontSize: 11, color: '#7A7268', marginTop: 2 }}>{q.frequency}</p></div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SectionTitle icon="😤" title="Pain Points Mentioned Most" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.painPoints.map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#0F0E0C', borderRadius: 8, border: '1px solid #2E2820' }}>
                <span style={{ fontSize: 13, color: '#F0EBE3', flex: 1 }}>{p.point}</span>
                <span style={{ fontSize: 11, color: '#E05252', fontWeight: 600, background: '#2A1515', padding: '2px 8px', borderRadius: 999, marginLeft: 10 }}>{p.mentions}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <SectionTitle icon="💡" title="Content Ideas Hidden in Comments" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {data.contentIdeas.map((idea, i) => (
            <div key={i} style={{ padding: '14px', background: '#0F0E0C', borderRadius: 10, border: '1px solid #2E2820' }}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}><StepBadge n={i + 1} /><p style={{ fontSize: 13, fontWeight: 600, color: '#F0EBE3', lineHeight: 1.4 }}>{idea.idea}</p></div>
              <p style={{ fontSize: 11, color: '#7A7268', lineHeight: 1.5 }}>From: {idea.basis}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle icon="📅" title="Suggested Next Content Ideas Based on Demand" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {data.nextVideoIdeas.map((v, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '16px', background: '#0F0E0C', borderRadius: 10, border: '1px solid #2E2820' }}>
              <StepBadge n={i + 1} />
              <div><p style={{ fontSize: 14, fontWeight: 700, color: '#EF9F27', marginBottom: 4 }}>{v.title}</p><p style={{ fontSize: 12, color: '#7A7268', lineHeight: 1.6 }}>{v.reason}</p></div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle icon="🗣️" title="Phrases Your Audience Uses (Mirror in Future Content)" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{data.audiencePhrases.map((p, i) => <Tag key={i}>{p}</Tag>)}</div>
        <p style={{ fontSize: 12, color: '#7A7268', marginTop: 14, lineHeight: 1.6 }}>Use these exact phrases in your next captions and hooks — your audience already speaks this language.</p>
      </Card>

      {data.toxicComments && data.toxicComments.length > 0 && (
        <Card style={{ borderColor: '#3A1515' }}>
          <SectionTitle icon="🚨" title="Accounts Using Hate Speech or Bad Language" />
          <p style={{ fontSize: 12, color: '#7A7268', marginBottom: 16 }}>These users may warrant a review or block.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.toxicComments.map((t, i) => (
              <div key={i} style={{ padding: '12px 16px', background: '#1A0E0E', borderRadius: 8, border: '1px solid #3A1515' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#E05252' }}>@{t.author}</span>
                  <span style={{ fontSize: 11, color: '#E05252', background: '#2A1010', padding: '2px 8px', borderRadius: 999 }}>{t.reason}</span>
                </div>
                <p style={{ fontSize: 12, color: '#7A7268', lineHeight: 1.5 }}>"{t.text}"</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── MAIN PAGE ───────────────────────────────────────────────────────────────
export default function Instagram() {
  const [connection, setConnection] = useState('idle') // idle | connecting | connected | error
  const [connectError, setConnectError] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [igUserId, setIgUserId] = useState('')
  const [posts, setPosts] = useState([])
  const [postsLoading, setPostsLoading] = useState(false)
  const [profile, setProfile] = useState(null)

  const [selectedPost, setSelectedPost] = useState(null)
  const [status, setStatus] = useState('idle') // idle | fetching | analyzing | done | error
  const [statusMsg, setStatusMsg] = useState('')
  const [report, setReport] = useState(null)
  const [comments, setComments] = useState([])
  const [commentCount, setCommentCount] = useState(0)
  const [error, setError] = useState('')

  const [groqKey, setGroqKey] = useState(() => localStorage.getItem(LS_GROQ) || '')
  const effectiveGroq = groqKey.trim() || DEFAULT_GROQ_KEY

  function handleSaveKeys(g) {
    setGroqKey(g)
    localStorage.setItem(LS_GROQ, g)
  }

  // ── On mount: resume an existing session, or handle the OAuth redirect ──
  useEffect(() => {
    const existingToken = sessionStorage.getItem(SS_IG_TOKEN)
    const existingUserId = sessionStorage.getItem(SS_IG_USER_ID)
    if (existingToken && existingUserId) {
      const cachedProfile = sessionStorage.getItem(SS_IG_PROFILE)
      setAccessToken(existingToken)
      setIgUserId(existingUserId)
      if (cachedProfile) {
        try { setProfile(JSON.parse(cachedProfile)) } catch { /* ignore */ }
      }
      setConnection('connected')
      loadPosts(existingUserId, existingToken)
      return
    }

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const oauthError = params.get('error_description') || params.get('error')

    if (oauthError) {
      setConnectError(oauthError)
      setConnection('idle')
      window.history.replaceState({}, '', '/instagram')
      return
    }

    if (code) {
      // Guard against this exact code ever being exchanged twice — e.g. a
      // duplicate page load, a StrictMode double-invoke, or a race where the
      // user navigates back to a stale URL still holding an old ?code=.
      // Facebook authorization codes are single-use, so a second exchange
      // attempt with the same code always fails with a confusing
      // "redirect_uri" error even though the redirect_uri was correct.
      const alreadyHandled = sessionStorage.getItem('pixelforge_ig_code_used')
      if (alreadyHandled === code) {
        window.history.replaceState({}, '', '/instagram')
        return
      }
      sessionStorage.setItem('pixelforge_ig_code_used', code)

      // Strip the code from the URL immediately, synchronously — before the
      // network request even starts — so no possible re-render or re-mount
      // can read this same ?code= param again.
      window.history.replaceState({}, '', '/instagram')

      setConnection('connecting')
      exchangeCodeForToken(code)
        .then(({ accessToken: token, igUserId: userId, username, profilePictureUrl }) => {
          sessionStorage.setItem(SS_IG_TOKEN, token)
          sessionStorage.setItem(SS_IG_USER_ID, userId)
          const prof = { username, profile_picture_url: profilePictureUrl }
          sessionStorage.setItem(SS_IG_PROFILE, JSON.stringify(prof))
          setAccessToken(token)
          setIgUserId(userId)
          setProfile(prof)
          setConnection('connected')
          return loadPosts(userId, token)
        })
        .catch(e => {
          setConnectError(e.message || 'Failed to connect Instagram account')
          setConnection('idle')
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadPosts(userId, token) {
    setPostsLoading(true)
    try {
      const media = await fetchRecentMedia(userId, token)
      setPosts(media)
    } catch (e) {
      setConnectError(e.message || 'Failed to load posts')
    } finally {
      setPostsLoading(false)
    }
  }

  function handleConnect() {
    setConnectError('')
    setConnection('connecting')
    window.location.href = buildAuthUrl()
  }

  function handleDisconnect() {
    sessionStorage.removeItem(SS_IG_TOKEN)
    sessionStorage.removeItem(SS_IG_USER_ID)
    sessionStorage.removeItem(SS_IG_PROFILE)
    setAccessToken('')
    setIgUserId('')
    setConnection('idle')
    setPosts([])
    setProfile(null)
    handleReset()
  }

  async function handleSelectPost(post) {
    if (!effectiveGroq) {
      setError('No Groq API key available. Add your own in API Settings, or set VITE_GROQ_API_KEY.')
      return
    }
    setSelectedPost(post)
    setError('')
    setReport(null)
    setComments([])
    // ── TEMPORARY DEBUG LOGGING — remove once comments-on-reels is fixed ──
    console.log('[handleSelectPost] full post object:', post)
    try {
      setStatus('fetching')
      setStatusMsg('Fetching comments from Instagram...')
      const fetched = await fetchPostComments(post.id, accessToken)
      if (fetched.length === 0) {
        setError('No comments found on this post.')
        setStatus('idle')
        return
      }
      setComments(fetched)
      setCommentCount(fetched.length)

      setStatus('analyzing')
      const result = await analyzeAllComments(fetched, effectiveGroq, (p) => setStatusMsg(`Analyzing ${p.totalComments} comments...`))
      setReport(result)
      setStatus('done')
    } catch (e) {
      setError(e.message || 'Something went wrong.')
      setStatus('error')
    }
  }

  function handleReset() {
    setSelectedPost(null)
    setReport(null)
    setComments([])
    setStatus('idle')
    setError('')
    setCommentCount(0)
  }

  function handleDownloadPdf() {
    if (!report) return
    downloadPdfReport(report, { commentCount, postUrl: selectedPost?.permalink || '', generatedAt: new Date().toLocaleString() })
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '40px 20px' }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: '#EF9F27', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10 }}>
          AI Comment Analyzer · Instagram
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#F0EBE3', letterSpacing: '-0.5px' }}>
          What is your Instagram audience really saying?
        </h1>
        <p style={{ color: '#7A7268', fontSize: 14, marginTop: 8, lineHeight: 1.7 }}>
          Connect your account, pick a post, and get a full intelligence report on its comments.
        </p>
      </div>

      <SettingsPanel groqKey={groqKey} onSave={handleSaveKeys} />

      {connection !== 'connected' && (
        <Card>
          <ConnectScreen onConnect={handleConnect} connecting={connection === 'connecting'} error={connectError} />
        </Card>
      )}

      {connection === 'connected' && status === 'idle' && !report && (
        postsLoading
          ? <LoadingPulse message="Loading your recent posts..." />
          : <Card><PostGrid posts={posts} profile={profile} onSelect={handleSelectPost} onDisconnect={handleDisconnect} /></Card>
      )}

      {error && status !== 'fetching' && status !== 'analyzing' && (
        <p style={{ marginTop: 12, fontSize: 13, color: '#E05252', background: '#1A0E0E', padding: '10px 14px', borderRadius: 8, border: '1px solid #3A1515' }}>
          ⚠️ {error}
        </p>
      )}

      {(status === 'fetching' || status === 'analyzing') && <LoadingPulse message={statusMsg} />}

      {status === 'done' && report && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={handleDownloadPdf} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #2E2820', background: '#242018', color: '#F0EBE3', fontSize: 13, fontWeight: 600 }}>⬇ Download Report (.pdf)</button>
            </div>
            <button onClick={handleReset} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #2E2820', background: 'transparent', color: '#7A7268', fontSize: 13, fontWeight: 600 }}>← Analyze Another Post</button>
          </div>
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 0', minWidth: 0 }}><Report data={report} commentCount={commentCount} /></div>
            <div style={{ width: 360, flexShrink: 0, position: 'sticky', top: 24 }}>
              <ChatBot comments={comments} report={report} apiKey={effectiveGroq} postUrl={selectedPost?.permalink || ''} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}