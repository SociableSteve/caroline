import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
// Self-hosted, so Vite bundles the woff2 files rather than the app fetching a font from a CDN on
// load. `--font-sans`/`--font-mono` in styles.css name these families exactly ('Geist Variable',
// 'Geist Mono Variable'), which is what the family actually calls itself here, not what the
// typeface is casually called.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
