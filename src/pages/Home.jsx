import { useNavigate } from 'react-router-dom'

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
        color: '#7A7268', fontSize: '1.1rem', maxWidth: 480,
        lineHeight: 1.75, marginBottom: 44,
      }}>
        Paste any YouTube video link and our AI analyzes every comment —
        extracting audience pain points, content ideas, and sentiment in seconds.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={() => navigate('/analyzer')} style={{
          padding: '14px 32px', borderRadius: 10, border: 'none',
          background: 'linear-gradient(135deg, #D85A30, #EF9F27)',
          color: '#fff', fontWeight: 700, fontSize: '1rem',
          boxShadow: '0 4px 20px rgba(216,90,48,0.35)',
        }}>
          Analyze Comments →
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
        Built by Team PixelForge · Powered by Groq + YouTube API
      </div>
    </main>
  )
}

export default Home
