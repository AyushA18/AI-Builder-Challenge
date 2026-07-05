function Home() {
  return (
    <main style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 'calc(100vh - 61px)',
      padding: '40px 20px',
      textAlign: 'center',
    }}>
      {/* Pixel flame icon */}
      <div style={{ fontSize: 64, marginBottom: 24 }}>🔥</div>

      <h1 style={{
        fontSize: 'clamp(2rem, 5vw, 3.5rem)',
        fontWeight: 900,
        background: 'linear-gradient(135deg, #D85A30, #EF9F27)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        marginBottom: 16,
      }}>
        PixelForge
      </h1>

      <p style={{
        color: '#9A9086',
        fontSize: '1.15rem',
        maxWidth: 500,
        lineHeight: 1.7,
        marginBottom: 40,
      }}>
        Reimagining creative industries with AI — crafting the future of human expression, one pixel at a time.
      </p>

      <div style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}>
        <button style={{
          padding: '12px 28px',
          borderRadius: 8,
          border: 'none',
          background: 'linear-gradient(135deg, #D85A30, #EF9F27)',
          color: '#fff',
          fontWeight: 700,
          fontSize: '1rem',
        }}>
          Get Started
        </button>
        <button style={{
          padding: '12px 28px',
          borderRadius: 8,
          border: '1px solid #3A332C',
          background: 'transparent',
          color: '#F5F0EA',
          fontWeight: 600,
          fontSize: '1rem',
        }}>
          Learn More
        </button>
      </div>

      {/* Team badge */}
      <div style={{
        marginTop: 60,
        padding: '10px 20px',
        borderRadius: 999,
        border: '1px solid #3A332C',
        color: '#9A9086',
        fontSize: 13,
      }}>
        Built at July Hackathon 2026 · Team PixelForge
      </div>
    </main>
  )
}

export default Home
