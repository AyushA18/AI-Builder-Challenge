import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import Analyzer from './pages/Analyzer'
import Instagram from './pages/Instagram'
import './index.css'

function Navbar() {
  const loc = useLocation()
  const linkStyle = (path) => ({
    fontSize: 14,
    fontWeight: 500,
    color: loc.pathname === path ? '#EF9F27' : '#7A7268',
    transition: 'color 0.2s',
    padding: '4px 0',
    borderBottom: loc.pathname === path ? '1px solid #EF9F27' : '1px solid transparent',
  })
  return (
    <nav style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 32px', height: 60,
      borderBottom: '1px solid #2E2820',
      background: '#0F0E0C',
      position: 'sticky', top: 0, zIndex: 100,
    }}>
      <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
        <span style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-0.5px' }}>
          <span style={{ color: '#EF9F27' }}>Pixel</span>
          <span style={{ color: '#F0EBE3' }}>Forge</span>
        </span>
      </Link>
      <div style={{ display: 'flex', gap: 28 }}>
        <Link to="/" style={linkStyle('/')}>Home</Link>
        <Link to="/analyzer" style={linkStyle('/analyzer')}>Comment Analyzer</Link>
        <Link to="/instagram" style={linkStyle('/instagram')}>Instagram</Link>
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
        <Route path="/analyzer" element={<Analyzer />} />
        <Route path="/instagram" element={<Instagram />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App