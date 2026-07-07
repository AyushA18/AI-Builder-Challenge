import { useState } from 'react'

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// 👇 ADD YOUR GROQ API KEY IN YOUR .env FILE AS: VITE_GROQ_API_KEY=your_key_here
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY
const YOUTUBE_API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY
const GROQ_MODEL = 'llama-3.3-70b-versatile'

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

async function fetchComments(videoId) {
  let comments = []
  let pageToken = ''
  let pages = 0

  while (pages < 3) {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=100&order=relevance${pageToken ? `&pageToken=${pageToken}` : ''}&key=${YOUTUBE_API_KEY}`
    const res = await fetch(url)
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error?.message || 'Failed to fetch comments')
    }
    const data = await res.json()
    for (const item of data.items || []) {
      const s = item.snippet.topLevelComment.snippet
      comments.push({
        author: s.authorDisplayName,
        text: s.textDisplay.replace(/<[^>]*>/g, ''),
        likes: s.likeCount,
        authorChannel: s.authorChannelUrl || '',
      })
    }
    if (data.nextPageToken && pages < 2) {
      pageToken = `&pageToken=${data.nextPageToken}`
      pages++
    } else break
  }
  return comments
}

async function analyzeWithGroq(comments) {
  const commentText = comments
    .map((c, i) => `[${i + 1}] @${c.author} (👍 ${c.likes}): ${c.text}`)
    .join('\n')

  const prompt = `You are an expert YouTube audience analyst. Analyze the following ${comments.length} comments from a YouTube video and return a detailed JSON report.

COMMENTS:
${commentText}

Return ONLY valid JSON with exactly this structure (no markdown, no explanation):
{
  "sentiment": {
    "positive": <number 0-100>,
    "neutral": <number 0-100>,
    "negative": <number 0-100>,
    "summary": "<one sentence overall vibe>"
  },
  "topQuestions": [
    {"question": "<question text>", "frequency": "<how many asked similar>"},
    {"question": "...", "frequency": "..."},
    {"question": "...", "frequency": "..."},
    {"question": "...", "frequency": "..."},
    {"question": "...", "frequency": "..."}
  ],
  "contentIdeas": [
    {"idea": "<content idea>", "basis": "<which comments inspired this>"},
    {"idea": "...", "basis": "..."},
    {"idea": "...", "basis": "..."},
    {"idea": "...", "basis": "..."},
    {"idea": "...", "basis": "..."}
  ],
  "painPoints": [
    {"point": "<pain point>", "mentions": "<approximate count>"},
    {"point": "...", "mentions": "..."},
    {"point": "...", "mentions": "..."}
  ],
  "topComment": {
    "author": "<username>",
    "text": "<comment text>",
    "likes": <number>,
    "whyItResonated": "<explanation>"
  },
  "audiencePhrases": [
    "<phrase 1>", "<phrase 2>", "<phrase 3>", "<phrase 4>", "<phrase 5>",
    "<phrase 6>", "<phrase 7>", "<phrase 8>"
  ],
  "nextVideoIdeas": [
    {"title": "<video title idea>", "reason": "<why audience wants this>"},
    {"title": "...", "reason": "..."},
    {"title": "...", "reason": "..."}
  ],
  "toxicComments": [
    {"author": "<username>", "text": "<the comment>", "reason": "<why it's toxic>"},
    {"author": "...", "text": "...", "reason": "..."}
  ]
}`

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 3000,
    }),
  })

  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error?.message || 'Groq API error')
  }

  const data = await res.json()
  const raw = data.choices[0].message.content.trim()
  const clean = raw.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
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
      <p style={{ color: '#7A7268', fontSize: 13, marginTop: 8 }}>This takes about 10–15 seconds</p>
      <style>{`@keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }`}</style>
    </div>
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
  const [commentCount, setCommentCount] = useState(0)
  const [error, setError] = useState('')

  async function handleAnalyze() {
    if (!url.trim()) return
    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      setError('Could not extract a video ID from that URL. Please paste a valid YouTube link.')
      return
    }
    if (!GROQ_API_KEY) {
      setError('Groq API key is missing. Add VITE_GROQ_API_KEY to your .env file.')
      return
    }

    setError('')
    setReport(null)
    try {
      setStatus('fetching')
      setStatusMsg('Fetching comments from YouTube...')
      const comments = await fetchComments(videoId)
      if (comments.length === 0) {
        setError('No comments found on this video. It may have comments disabled.')
        setStatus('idle')
        return
      }
      setCommentCount(comments.length)

      setStatus('analyzing')
      setStatusMsg(`Analyzing ${comments.length} comments with AI...`)
      const result = await analyzeWithGroq(comments)

      setReport(result)
      setStatus('done')
    } catch (e) {
      setError(e.message || 'Something went wrong.')
      setStatus('error')
    }
  }

  function handleReset() {
    setUrl('')
    setReport(null)
    setStatus('idle')
    setError('')
    setCommentCount(0)
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '40px 20px' }}>
      {/* Page Title */}
      <div style={{ marginBottom: 36 }}>
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
          Paste a YouTube video URL and get a full intelligence report on your comment section in seconds.
        </p>
      </div>

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
            Works with any public YouTube video · Analyzes up to 300 comments
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
            <button onClick={handleReset} style={{
              padding: '8px 18px', borderRadius: 8,
              border: '1px solid #2E2820', background: 'transparent',
              color: '#7A7268', fontSize: 13, fontWeight: 600,
            }}>
              ← Analyze Another Video
            </button>
          </div>
          <Report data={report} commentCount={commentCount} />
        </>
      )}
    </div>
  )
}
