import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Home from './pages/Home'
import './index.css'

function Navbar() {
  return (
    <nav style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '16px 32px',
      borderBottom: '1px solid #3A332C',
      background: '#1A1713',
    }}>
      <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: '#EF9F27', letterSpacing: 1 }}>
          ⬛ PixelForge
        </span>
      </Link>
      <div style={{ display: 'flex', gap: 24, color: '#9A9086', fontSize: 14 }}>
        <Link to="/">Home</Link>
      </div>
    </nav>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
