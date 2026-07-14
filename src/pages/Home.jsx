import { useNavigate } from 'react-router-dom'

// Inline SVG logos — no external assets needed
function YouTubeLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#FF0000" />
      <path d="M19.6 7.8a2.1 2.1 0 0 0-1.48-1.49C16.76 6 12 6 12 6s-4.76 0-6.12.31A2.1 2.1 0 0 0 4.4 7.8C4.1 9.16 4.1 12 4.1 12s0 2.84.3 4.2a2.1 2.1 0 0 0 1.48 1.49C7.24 18 12 18 12 18s4.76 0 6.12-.31a2.1 2.1 0 0 0 1.48-1.49c.3-1.36.3-4.2.3-4.2s0-2.84-.3-4.2z" fill="white" />
      <path d="M10.2 14.7V9.3l4.8 2.7-4.8 2.7z" fill="#FF0000" />
    </svg>
  )
}

function InstagramLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="ig-grad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#f09433" />
          <stop offset="25%" stopColor="#e6683c" />
          <stop offset="50%" stopColor="#dc2743" />
          <stop offset="75%" stopColor="#cc2366" />
          <stop offset="100%" stopColor="#bc1888" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#ig-grad)" />
      <rect x="6" y="6" width="12" height="12" rx="3.5" stroke="white" strokeWidth="1.5" fill="none" />
      <circle cx="12" cy="12" r="3" stroke="white" strokeWidth="1.5" fill="none" />
      <circle cx="16.2" cy="7.8" r="0.9" fill="white" />
    </svg>
  )
}

function Home() {
  const navigate = useNavigate()
  return (
    <main style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: 'calc(100vh - 60px)',
      padding: '40px 20px', textAlign: 'center',
    }}>
      <div style={{
        display: 'inline-block', background: '#1A1815', border: '1px solid #2E2820',
        borderRadius: 999, padding: '6px 16px', fontSize: 12,
        color: '#EF9F27', fontWeight: 600, letterSpacing: 1,
        textTransform: 'uppercase', marginBottom: 32,
      }}>
        July Hackathon 2026
      </div>

      <h1 style={{
        fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', fontWeight: 900,
        lineHeight: 1.05, letterSpacing: '-2px', marginBottom: 20,
      }}>
        Turn Comments into<br />
        <span style={{
          background: 'linear-gradient(135deg, #D85A30 0%, #EF9F27 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          Content Strategy
        </span>
      </h1>

      <p style={{
        color: '#7A7268', fontSize: '1.1rem', maxWidth: 520,
        lineHeight: 1.75, marginBottom: 44,
      }}>
        Paste a YouTube link or connect your Instagram account and our AI analyzes
        every comment — extracting audience pain points, content ideas, and sentiment in seconds.
      </p>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={() => navigate('/analyzer')}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '14px 28px', borderRadius: 10, border: 'none',
            background: '#1A1815', color: '#F0EBE3',
            fontWeight: 700, fontSize: '0.95rem',
            border: '1px solid #2E2820', cursor: 'pointer',
          }}
        >
          <YouTubeLogo size={22} />
          Analyze YouTube Comments
        </button>

        <button
          onClick={() => navigate('/instagram')}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '14px 28px', borderRadius: 10, border: 'none',
            background: 'linear-gradient(135deg, #D85A30, #EF9F27)',
            color: '#fff', fontWeight: 700, fontSize: '0.95rem',
            boxShadow: '0 4px 20px rgba(216,90,48,0.35)', cursor: 'pointer',
          }}
        >
          <InstagramLogo size={22} />
          Analyze Instagram Comments
        </button>
      </div>

      <div style={{
        display: 'flex', gap: 32, marginTop: 72, flexWrap: 'wrap', justifyContent: 'center',
      }}>
        {[
          { icon: '💬', label: 'Sentiment Analysis' },
          { icon: '💡', label: 'Content Ideas' },
          { icon: '😤', label: 'Pain Points' },
          { icon: '🚨', label: 'Toxic Comment Detection' },
        ].map(f => (
          <div key={f.label} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#7A7268', fontSize: 14,
          }}>
            <span style={{ fontSize: 18 }}>{f.icon}</span>
            <span>{f.label}</span>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 60, color: '#3A3328', fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
      }}>
        Built by Team PixelForge · Powered by Groq + YouTube API + Instagram API
      </div>
    </main>
  )
}

export default Home
