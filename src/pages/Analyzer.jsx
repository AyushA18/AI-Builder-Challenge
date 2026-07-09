import { useState, useRef, useEffect } from 'react'
import { jsPDF } from 'jspdf'

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// 👇 The Groq key is the DEFAULT key. Users can override it with their own key
// in the Settings panel — theirs is stored only in their browser (localStorage)
// and used instead of this whenever present.
// The YouTube key is NOT user-overridable — it always uses this project's key.
const DEFAULT_GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY
const YOUTUBE_API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY
const GROQ_MODEL = 'llama-3.3-70b-versatile'

const MAX_COMMENTS = 1500       // safety cap so one video can't fetch forever / blow quota
const ANALYZE_SAMPLE = 50       // comments randomly sampled and sent to Groq — keeps us under TPM limits
const LS_GROQ = 'pixelforge_groq_key'

// ─── HELPERS: YOUTUBE ────────────────────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\n?#]+)/,
    /(?:youtu\.be\/)([^&\n?#]+)/,
    /(?:youtube\.com\/embed\/)([^&\n?#]+)/,
    /(?:youtube\.com\/shorts\/)([^&\n?#]+)/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

// Fetches every available top-level comment (paginating through the YouTube API)
// instead of stopping after the first page or two.
async function fetchComments(videoId, ytKey, onProgress) {
  let comments = []
  let pageToken = ''

  while (comments.length < MAX_COMMENTS) {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=100&order=relevance${pageToken}&key=${ytKey}`
    const res = await fetch(url)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || 'Failed to fetch comments')
    }
    const data = await res.json()
    for (const item of data.items || []) {
      const s = item.snippet.topLevelComment.snippet
      comments.push({
        author: s.authorDisplayName,
        text: s.textDisplay.replace(/<[^>]*>/g, ''),
        likes: s.likeCount,
      })
    }
    onProgress?.(comments.length)
    if (data.nextPageToken) {
      pageToken = `&pageToken=${data.nextPageToken}`
    } else {
      break
    }
  }
  return comments.slice(0, MAX_COMMENTS)
}

// ─── HELPERS: GROQ ───────────────────────────────────────────────────────────
// Parse the "Please try again in X.XXs" wait time Groq includes in 429 messages.
function parseRetryAfterMs(message = '') {
  const m = message.match(/try again in ([0-9.]+)s/i)
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null
}

async function callGroq(apiKey, messages, maxTokens = 2000) {
  const MAX_RETRIES = 6
  let attempt = 0

  while (true) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const msg = err.error?.message || `Groq API error (${res.status})`

      // Only retry on rate-limit (429); throw everything else immediately.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        attempt++
        // Use the wait time Groq tells us, plus a 500 ms safety buffer.
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

function dedupe(arr) {
  const seen = new Set()
  const out = []
  for (const item of arr || []) {
    const key = (item || '').toLowerCase().trim()
    if (key && !seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

function dedupeToxic(arr) {
  const seen = new Set()
  const out = []
  for (const item of arr || []) {
    const key = `${item.author}|${item.text}`.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

// Build the single extraction prompt for all 50 sampled comments.
function buildExtractPrompt(comments) {
  const commentText = comments
    .map((c, i) => `[${i + 1}] @${c.author} (👍 ${c.likes}): ${c.text.slice(0, 200)}`)
    .join('\n')

  return `You are analyzing ${comments.length} YouTube comments. Extract raw signal from them.

COMMENTS:
${commentText}

Return ONLY valid JSON, no markdown, no explanation:
{
  "sentimentCounts": {"positive": <number>, "neutral": <number>, "negative": <number>},
  "questions": ["<distinct question seen in comments>"],
  "painPoints": ["<pain point or complaint mentioned>"],
  "contentIdeas": ["<content idea implied by comments>"],
  "phrases": ["<notable recurring phrase or slang>"],
  "topComment": {"author": "<username>", "text": "<comment text>", "likes": <number>},
  "toxicComments": [{"author": "<username>", "text": "<comment>", "reason": "<why it's toxic>"}]
}
(Arrays can be empty. Include at most 5 items per array except toxicComments.)`
}

// Sends all sampled comments to Groq in a single call.
async function analyzeChunk(comments, apiKey) {
  return await callGroq(apiKey, [{ role: 'user', content: buildExtractPrompt(comments) }], 1200)
}

// "Reduce" step: turn the aggregated candidates into the final polished report.
function buildFinalSynthesisPrompt({ candidateQuestions, candidatePainPoints, candidateIdeas, candidatePhrases, topComment, sentiment, totalComments }) {
  return `You analyzed ${totalComments} YouTube comments in batches and extracted these raw candidate signals across all of them. Now synthesize the FINAL polished report — merge duplicates/near-duplicates and keep only the strongest, most representative items.

CANDIDATE QUESTIONS SEEN:
${candidateQuestions.map(q => `- ${q}`).join('\n') || '(none)'}

CANDIDATE PAIN POINTS:
${candidatePainPoints.map(p => `- ${p}`).join('\n') || '(none)'}

CANDIDATE CONTENT IDEAS:
${candidateIdeas.map(c => `- ${c}`).join('\n') || '(none)'}

CANDIDATE RECURRING PHRASES:
${candidatePhrases.map(p => `- ${p}`).join('\n') || '(none)'}

SENTIMENT BREAKDOWN (computed precisely from all ${totalComments} comments): ${sentiment.positive}% positive, ${sentiment.neutral}% neutral, ${sentiment.negative}% negative

MOST-LIKED COMMENT: @${topComment.author} (👍 ${topComment.likes}): "${topComment.text}"

Return ONLY valid JSON, no markdown, no explanation:
{
  "sentimentSummary": "<one sentence overall vibe consistent with the breakdown above>",
  "topQuestions": [{"question": "...", "frequency": "..."}],
  "painPoints": [{"point": "...", "mentions": "..."}],
  "contentIdeas": [{"idea": "...", "basis": "..."}],
  "audiencePhrases": ["...", "..."],
  "nextVideoIdeas": [{"title": "...", "reason": "..."}],
  "whyTopCommentResonated": "<one sentence explaining why the most-liked comment above resonated>"
}
(topQuestions: up to 5, painPoints: up to 3, contentIdeas: up to 5, audiencePhrases: up to 8, nextVideoIdeas: up to 3.)`
}

// Randomly sample up to ANALYZE_SAMPLE comments, favouring shorter ones so we
// stay well under the free-tier TPM ceiling for a single Groq call.
function sampleAnalysisComments(comments) {
  if (comments.length <= ANALYZE_SAMPLE) return comments
  // Fisher-Yates shuffle on a copy, then take the first ANALYZE_SAMPLE.
  const pool = [...comments]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, ANALYZE_SAMPLE)
}

// Analyzes a random sample of 50 comments in a single Groq call.
async function analyzeAllComments(comments, apiKey, onProgress) {
  const sample = sampleAnalysisComments(comments)

  onProgress?.({ phase: 'batch', batch: 1, totalBatches: 1, totalComments: sample.length })
  const combined = await analyzeChunk(sample, apiKey)

  const totalCounted =
    combined.sentimentCounts.positive + combined.sentimentCounts.neutral + combined.sentimentCounts.negative || 1
  const sentiment = {
    positive: Math.round((combined.sentimentCounts.positive / totalCounted) * 100),
    neutral: Math.round((combined.sentimentCounts.neutral / totalCounted) * 100),
    negative: Math.round((combined.sentimentCounts.negative / totalCounted) * 100),
  }

  onProgress?.({ phase: 'synthesizing', totalComments: sample.length })
  const topComment = combined.topComment || { author: 'unknown', text: '', likes: 0 }
  const final = await callGroq(apiKey, [{
    role: 'user',
    content: buildFinalSynthesisPrompt({
      candidateQuestions: dedupe(combined.questions).slice(0, 40),
      candidatePainPoints: dedupe(combined.painPoints).slice(0, 40),
      candidateIdeas: dedupe(combined.contentIdeas).slice(0, 40),
      candidatePhrases: dedupe(combined.phrases).slice(0, 40),
      topComment,
      sentiment,
      totalComments: sample.length,
    }),
  }], 2000)

  return {
    sentiment: { ...sentiment, summary: final.sentimentSummary },
    topQuestions: final.topQuestions,
    painPoints: final.painPoints,
    contentIdeas: final.contentIdeas,
    audiencePhrases: final.audiencePhrases,
    nextVideoIdeas: final.nextVideoIdeas,
    topComment: { ...topComment, whyItResonated: final.whyTopCommentResonated },
    toxicComments: dedupeToxic(combined.toxicComments).slice(0, 10),
  }
}

// ─── HELPERS: PDF DOWNLOAD ───────────────────────────────────────────────────
function downloadPdfReport(report, meta) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 48
  const maxWidth = pageWidth - margin * 2
  let y = 56

  function checkPageBreak(need = 16) {
    if (y + need > pageHeight - margin) {
      doc.addPage()
      y = 56
    }
  }
  function addTitle(text) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(18)
    doc.setTextColor(20, 20, 20)
    doc.text(text, margin, y)
    y += 26
  }
  function addMeta(text) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(110, 110, 110)
    doc.text(text, margin, y)
    y += 14
  }
  function addHeading(text) {
    y += 8
    checkPageBreak(28)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(216, 90, 48)
    doc.text(text, margin, y)
    y += 18
  }
  function addBody(text, { bold = false, indent = 0 } = {}) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(11)
    doc.setTextColor(40, 40, 40)
    const lines = doc.splitTextToSize(text, maxWidth - indent)
    for (const line of lines) {
      checkPageBreak(16)
      doc.text(line, margin + indent, y)
      y += 15
    }
    y += 4
  }

  addTitle('Comment Intelligence Report')
  addMeta(`Video: ${meta.videoUrl}`)
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
  report.contentIdeas.forEach((c, i) => {
    addBody(`${i + 1}. ${c.idea}`, { bold: true })
    addBody(`From: ${c.basis}`, { indent: 14 })
  })

  addHeading('Suggested Next Videos')
  report.nextVideoIdeas.forEach((v, i) => {
    addBody(`${i + 1}. ${v.title}`, { bold: true })
    addBody(v.reason, { indent: 14 })
  })

  addHeading('Audience Phrases')
  addBody(report.audiencePhrases.join(', '))

  if (report.toxicComments?.length) {
    addHeading('Flagged Comments')
    report.toxicComments.forEach(t => addBody(`@${t.author}: "${t.text}" — ${t.reason}`))
  }

  doc.save(`comment-report-${Date.now()}.pdf`)
}

// ─── SUB COMPONENTS ──────────────────────────────────────────────────────────
function Card({ children, style = {} }) {
  return (
    <div style={{
      background: '#1A1815', border: '1px solid #2E2820',
      borderRadius: 14, padding: '24px', ...style,
    }}>
      {children}
    </div>
  )
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
        <div style={{
          width: `${value}%`, height: '100%',
          background: color, borderRadius: 999,
          transition: 'width 1s ease',
        }} />
      </div>
    </div>
  )
}

function Tag({ children }) {
  return (
    <span style={{
      display: 'inline-block', padding: '4px 12px', borderRadius: 999,
      background: '#242018', border: '1px solid #2E2820',
      fontSize: 12, color: '#EF9F27', fontWeight: 500, margin: '3px',
    }}>
      {children}
    </span>
  )
}

function StepBadge({ n }) {
  return (
    <div style={{
      width: 28, height: 28, borderRadius: 999, flexShrink: 0,
      background: 'linear-gradient(135deg,#D85A30,#EF9F27)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 800, color: '#fff',
    }}>{n}</div>
  )
}

function LoadingPulse({ message }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <div style={{ fontSize: 48, marginBottom: 20, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>
        🔥
      </div>
      <p style={{ color: '#EF9F27', fontWeight: 600, fontSize: 16 }}>{message}</p>
      <p style={{ color: '#7A7268', fontSize: 13, marginTop: 8 }}>Analyzing a random sample of {ANALYZE_SAMPLE} comments…</p>
      <style>{`@keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }`}</style>
    </div>
  )
}

// ─── SETTINGS (BRING-YOUR-OWN API KEY) ──────────────────────────────────────
function SettingsPanel({ groqKey, onSave }) {
  const [open, setOpen] = useState(false)
  const [g, setG] = useState(groqKey)
  const usingOwnGroq = !!groqKey.trim()

  useEffect(() => { setG(groqKey) }, [groqKey])

  const inputStyle = {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    border: '1px solid #2E2820', background: '#0F0E0C',
    color: '#F0EBE3', fontSize: 13, outline: 'none',
    fontFamily: 'JetBrains Mono, monospace', marginTop: 6, marginBottom: 14,
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'transparent', border: '1px solid #2E2820',
          borderRadius: 8, padding: '8px 14px', color: '#7A7268',
          fontSize: 13, fontWeight: 600,
        }}
      >
        ⚙️ API Settings
        {usingOwnGroq && (
          <span style={{ color: '#4CAF7D', fontSize: 11, background: '#12251A', padding: '2px 8px', borderRadius: 999 }}>
            using your key
          </span>
        )}
      </button>

      {open && (
        <Card style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, color: '#7A7268', marginBottom: 16, lineHeight: 1.6 }}>
            Optional — bring your own API key instead of the shared demo key. It's saved only in
            your browser and sent straight to the API provider, never through our servers. Leave blank
            to keep using the default. (YouTube comment fetching always uses this project's own key.)
          </p>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#F0EBE3' }}>Your API key</label>
          <input type="password" value={g} onChange={e => setG(e.target.value)} placeholder="Enter your API key..." style={inputStyle} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => { onSave(g.trim()); setOpen(false) }}
              style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#D85A30,#EF9F27)', color: '#fff', fontWeight: 700, fontSize: 13 }}
            >
              Save
            </button>
            <button
              onClick={() => { setG(''); onSave('') }}
              style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #2E2820', background: 'transparent', color: '#7A7268', fontWeight: 600, fontSize: 13 }}
            >
              Clear / use default
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── CHATBOT ─────────────────────────────────────────────────────────────────
// Pick at most 50 representative comments to keep the chat system prompt
// well under the 12 000 TPM free-tier ceiling.
//
// Selection rules (in priority order):
//  1. Always include the top-10 most-liked comments (high signal).
//  2. From the remaining pool, drop comments whose text exceeds 120 chars
//     AND have fewer than 2 likes (low-value long comments).
//  3. Randomly sample from what's left until we reach 50 total.
//  4. Each comment text is hard-capped at 120 chars in the corpus string.
function sampleChatComments(comments, max = 50) {
  if (comments.length <= max) return comments

  // Sort by likes descending so top comments are always first.
  const sorted = [...comments].sort((a, b) => (b.likes || 0) - (a.likes || 0))

  const top = sorted.slice(0, 10)
  const rest = sorted.slice(10)

  // Filter out long low-engagement comments from the candidate pool.
  const candidates = rest.filter(c => c.text.length <= 120 || (c.likes || 0) >= 2)

  // Random shuffle the candidates then take what we still need.
  const needed = max - top.length
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  return [...top, ...candidates.slice(0, needed)]
}

function ChatBot({ comments, report, apiKey, videoUrl }) {
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
      const commentCorpus = sample
        .map(c => `@${c.author} (👍${c.likes}): ${c.text.slice(0, 120)}`)
        .join('\n')

      const systemPrompt = `You are a helpful assistant answering questions about the comment section of a YouTube video (${videoUrl}). You have an analysis report and a sample of ${sample.length} representative comments (selected from ${comments.length} total) below. Answer the user's question directly and concisely, referencing specific commenters where useful. If the comments don't cover something, say so honestly rather than guessing.

ANALYSIS REPORT SUMMARY:
${JSON.stringify({ sentiment: report.sentiment, topQuestions: report.topQuestions, painPoints: report.painPoints, contentIdeas: report.contentIdeas })}

COMMENTS SAMPLE:
${commentCorpus}`

      // Chat replies are plain text (not JSON), so we call the API directly
      // with the same retry-on-429 logic used by callGroq.
      const MAX_RETRIES = 6
      let attempt = 0
      let reply = null

      while (reply === null) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [{ role: 'system', content: systemPrompt }, ...newMessages],
            temperature: 0.4,
            max_tokens: 600,
          }),
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
        {messages.length === 0 && (
          <p style={{ fontSize: 13, color: '#7A7268' }}>
            Try: "What do people want in the next video?" or "Are there recurring complaints?"
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '80%', padding: '10px 14px', borderRadius: 10,
            background: m.role === 'user' ? 'linear-gradient(135deg,#D85A30,#EF9F27)' : '#0F0E0C',
            color: m.role === 'user' ? '#fff' : '#F0EBE3',
            border: m.role === 'user' ? 'none' : '1px solid #2E2820',
            fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
          }}>
            {m.content}
          </div>
        ))}
        {loading && <div style={{ fontSize: 12, color: '#7A7268' }}>Thinking…</div>}
        <div ref={bottomRef} />
      </div>
      {chatError && <p style={{ fontSize: 12, color: '#E05252', marginBottom: 10 }}>⚠️ {chatError}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Ask a question about the comments..."
          style={{
            flex: 1, padding: '10px 14px', borderRadius: 8,
            border: '1px solid #2E2820', background: '#0F0E0C',
            color: '#F0EBE3', fontSize: 13, outline: 'none',
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            padding: '10px 20px', borderRadius: 8, border: 'none',
            background: input.trim() ? 'linear-gradient(135deg,#D85A30,#EF9F27)' : '#2E2820',
            color: input.trim() ? '#fff' : '#7A7268', fontWeight: 700, fontSize: 13,
          }}
        >
          Ask
        </button>
      </div>
    </Card>
  )
}

// ─── REPORT ──────────────────────────────────────────────────────────────────
function Report({ data, commentCount }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1E1510, #1A1815)',
        border: '1px solid #3A2818', borderRadius: 14, padding: '24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, color: '#EF9F27', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Comment Intelligence Report
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#F0EBE3' }}>Analysis Complete</div>
          <div style={{ fontSize: 13, color: '#7A7268', marginTop: 4 }}>
            Based on {commentCount} comments
          </div>
        </div>
        <div style={{
          background: '#0F0E0C', border: '1px solid #2E2820', borderRadius: 10,
          padding: '12px 20px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#EF9F27' }}>{commentCount}</div>
          <div style={{ fontSize: 11, color: '#7A7268' }}>Comments Analyzed</div>
        </div>
      </div>

      {/* Grid row 1: Sentiment + Top Comment */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card>
          <SectionTitle icon="💬" title="Overall Sentiment" />
          <p style={{ fontSize: 13, color: '#7A7268', marginBottom: 18, lineHeight: 1.6 }}>
            {data.sentiment.summary}
          </p>
          <SentimentBar label="Positive" value={data.sentiment.positive} color="#4CAF7D" />
          <SentimentBar label="Neutral" value={data.sentiment.neutral} color="#EF9F27" />
          <SentimentBar label="Negative" value={data.sentiment.negative} color="#E05252" />
        </Card>

        <Card>
          <SectionTitle icon="🔥" title="Most Resonant Comment" />
          <div style={{
            background: '#0F0E0C', borderRadius: 10, padding: '14px',
            border: '1px solid #2E2820', marginBottom: 14,
          }}>
            <div style={{ fontSize: 12, color: '#EF9F27', fontWeight: 600, marginBottom: 6 }}>
              @{data.topComment.author} · 👍 {data.topComment.likes}
            </div>
            <p style={{ fontSize: 13, color: '#F0EBE3', lineHeight: 1.6 }}>
              "{data.topComment.text}"
            </p>
          </div>
          <p style={{ fontSize: 12, color: '#7A7268', lineHeight: 1.6 }}>
            <span style={{ color: '#EF9F27', fontWeight: 600 }}>Why it resonated: </span>
            {data.topComment.whyItResonated}
          </p>
        </Card>
      </div>

      {/* Questions + Pain Points */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card>
          <SectionTitle icon="❓" title="Top Questions Your Audience is Asking" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.topQuestions.map((q, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <StepBadge n={i + 1} />
                <div>
                  <p style={{ fontSize: 13, color: '#F0EBE3', lineHeight: 1.5 }}>{q.question}</p>
                  <p style={{ fontSize: 11, color: '#7A7268', marginTop: 2 }}>{q.frequency}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle icon="😤" title="Pain Points Mentioned Most" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.painPoints.map((p, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', background: '#0F0E0C',
                borderRadius: 8, border: '1px solid #2E2820',
              }}>
                <span style={{ fontSize: 13, color: '#F0EBE3', flex: 1 }}>{p.point}</span>
                <span style={{
                  fontSize: 11, color: '#E05252', fontWeight: 600,
                  background: '#2A1515', padding: '2px 8px', borderRadius: 999, marginLeft: 10,
                }}>
                  {p.mentions}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Content Ideas */}
      <Card>
        <SectionTitle icon="💡" title="Content Ideas Hidden in Comments" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {data.contentIdeas.map((idea, i) => (
            <div key={i} style={{
              padding: '14px', background: '#0F0E0C',
              borderRadius: 10, border: '1px solid #2E2820',
            }}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                <StepBadge n={i + 1} />
                <p style={{ fontSize: 13, fontWeight: 600, color: '#F0EBE3', lineHeight: 1.4 }}>
                  {idea.idea}
                </p>
              </div>
              <p style={{ fontSize: 11, color: '#7A7268', lineHeight: 1.5 }}>
                From: {idea.basis}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* Next Video Ideas */}
      <Card>
        <SectionTitle icon="📅" title="Suggested Next 3 Video Ideas Based on Demand" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {data.nextVideoIdeas.map((v, i) => (
            <div key={i} style={{
              display: 'flex', gap: 14, alignItems: 'flex-start',
              padding: '16px', background: '#0F0E0C',
              borderRadius: 10, border: '1px solid #2E2820',
            }}>
              <StepBadge n={i + 1} />
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#EF9F27', marginBottom: 4 }}>
                  {v.title}
                </p>
                <p style={{ fontSize: 12, color: '#7A7268', lineHeight: 1.6 }}>{v.reason}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Audience Phrases */}
      <Card>
        <SectionTitle icon="🗣️" title="Phrases Your Audience Uses (Mirror in Future Content)" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {data.audiencePhrases.map((p, i) => <Tag key={i}>{p}</Tag>)}
        </div>
        <p style={{ fontSize: 12, color: '#7A7268', marginTop: 14, lineHeight: 1.6 }}>
          Use these exact phrases in your next titles, hooks, and captions — your audience already speaks this language.
        </p>
      </Card>

      {/* Toxic Comments */}
      {data.toxicComments && data.toxicComments.length > 0 && (
        <Card style={{ borderColor: '#3A1515' }}>
          <SectionTitle icon="🚨" title="Accounts Using Hate Speech or Bad Language" />
          <p style={{ fontSize: 12, color: '#7A7268', marginBottom: 16 }}>
            These users may warrant a review or block.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.toxicComments.map((t, i) => (
              <div key={i} style={{
                padding: '12px 16px', background: '#1A0E0E',
                borderRadius: 8, border: '1px solid #3A1515',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#E05252' }}>
                    @{t.author}
                  </span>
                  <span style={{
                    fontSize: 11, color: '#E05252', background: '#2A1010',
                    padding: '2px 8px', borderRadius: 999,
                  }}>
                    {t.reason}
                  </span>
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
export default function Analyzer() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState('idle') // idle | fetching | analyzing | done | error
  const [statusMsg, setStatusMsg] = useState('')
  const [report, setReport] = useState(null)
  const [comments, setComments] = useState([])
  const [commentCount, setCommentCount] = useState(0)
  const [videoUrlAnalyzed, setVideoUrlAnalyzed] = useState('')
  const [error, setError] = useState('')

  const [groqKey, setGroqKey] = useState(() => localStorage.getItem(LS_GROQ) || '')
  const effectiveGroq = groqKey.trim() || DEFAULT_GROQ_KEY

  function handleSaveKeys(g) {
    setGroqKey(g)
    localStorage.setItem(LS_GROQ, g)
  }

  async function handleAnalyze() {
    if (!url.trim()) return
    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      setError('Could not extract a video ID from that URL. Please paste a valid YouTube link.')
      return
    }
    if (!effectiveGroq) {
      setError('No Groq API key available. Add your own in API Settings, or set VITE_GROQ_API_KEY.')
      return
    }
    if (!YOUTUBE_API_KEY) {
      setError('YouTube API key is missing. Set VITE_YOUTUBE_API_KEY in your .env file.')
      return
    }

    setError('')
    setReport(null)
    setComments([])
    try {
      setStatus('fetching')
      setStatusMsg('Fetching comments from YouTube...')
      const fetched = await fetchComments(videoId, YOUTUBE_API_KEY, (n) =>
        setStatusMsg(`Fetching comments from YouTube... (${n} so far)`)
      )
      if (fetched.length === 0) {
        setError('No comments found on this video. It may have comments disabled.')
        setStatus('idle')
        return
      }
      setComments(fetched)
      setCommentCount(fetched.length)

      setStatus('analyzing')
      const result = await analyzeAllComments(fetched, effectiveGroq, (p) => {
        if (p.phase === 'synthesizing') {
          setStatusMsg(`Synthesizing report from ${p.totalComments} comments...`)
        } else {
          setStatusMsg(`Analyzing ${p.totalComments} sampled comments...`)
        }
      })

      setReport(result)
      setVideoUrlAnalyzed(url.trim())
      setStatus('done')
    } catch (e) {
      setError(e.message || 'Something went wrong.')
      setStatus('error')
    }
  }

  function handleReset() {
    setUrl('')
    setReport(null)
    setComments([])
    setStatus('idle')
    setError('')
    setCommentCount(0)
    setVideoUrlAnalyzed('')
  }

  function handleDownloadPdf() {
    if (!report) return
    downloadPdfReport(report, {
      commentCount, videoUrl: videoUrlAnalyzed, generatedAt: new Date().toLocaleString(),
    })
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '40px 20px' }}>
      {/* Page Title */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          fontSize: 11, color: '#EF9F27', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10,
        }}>
          AI Comment Analyzer
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#F0EBE3', letterSpacing: '-0.5px' }}>
          What is your audience really saying?
        </h1>
        <p style={{ color: '#7A7268', fontSize: 14, marginTop: 8, lineHeight: 1.7 }}>
          Paste a YouTube video URL and get a full intelligence report on your comment section.
        </p>
      </div>

      <SettingsPanel groqKey={groqKey} onSave={handleSaveKeys} />

      {/* Input */}
      {status !== 'done' && (
        <div style={{
          background: '#1A1815', border: '1px solid #2E2820',
          borderRadius: 14, padding: '24px', marginBottom: 28,
        }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: '#F0EBE3', display: 'block', marginBottom: 10 }}>
            YouTube Video URL
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={status === 'fetching' || status === 'analyzing'}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 8,
                border: '1px solid #2E2820', background: '#0F0E0C',
                color: '#F0EBE3', fontSize: 14, outline: 'none',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
            <button
              onClick={handleAnalyze}
              disabled={!url.trim() || status === 'fetching' || status === 'analyzing'}
              style={{
                padding: '12px 24px', borderRadius: 8, border: 'none',
                background: url.trim() ? 'linear-gradient(135deg,#D85A30,#EF9F27)' : '#2E2820',
                color: url.trim() ? '#fff' : '#7A7268',
                fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap',
                transition: 'all 0.2s',
              }}
            >
              Analyze →
            </button>
          </div>
          {error && (
            <p style={{
              marginTop: 12, fontSize: 13, color: '#E05252',
              background: '#1A0E0E', padding: '10px 14px',
              borderRadius: 8, border: '1px solid #3A1515',
            }}>
              ⚠️ {error}
            </p>
          )}
          <p style={{ fontSize: 11, color: '#3A3328', marginTop: 10 }}>
            Works with any public YouTube video · Randomly samples {ANALYZE_SAMPLE} comments for analysis
          </p>
        </div>
      )}

      {/* Loading */}
      {(status === 'fetching' || status === 'analyzing') && (
        <LoadingPulse message={statusMsg} />
      )}

      {/* Report */}
      {status === 'done' && report && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={handleDownloadPdf} style={{
                padding: '8px 18px', borderRadius: 8,
                border: '1px solid #2E2820', background: '#242018',
                color: '#F0EBE3', fontSize: 13, fontWeight: 600,
              }}>
                ⬇ Download Report (.pdf)
              </button>
            </div>
            <button onClick={handleReset} style={{
              padding: '8px 18px', borderRadius: 8,
              border: '1px solid #2E2820', background: 'transparent',
              color: '#7A7268', fontSize: 13, fontWeight: 600,
            }}>
              ← Analyze Another Video
            </button>
          </div>
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
            {/* Left column — report */}
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <Report data={report} commentCount={commentCount} />
            </div>
            {/* Right column — chatbot */}
            <div style={{ width: 360, flexShrink: 0, position: 'sticky', top: 24 }}>
              <ChatBot comments={comments} report={report} apiKey={effectiveGroq} videoUrl={videoUrlAnalyzed} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}