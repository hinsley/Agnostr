import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'

// Lock UI width to initial viewport width
try {
	const initialWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
	document.documentElement.style.setProperty('--initial-width', initialWidth + 'px')
} catch {}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerSW({ immediate: true })
