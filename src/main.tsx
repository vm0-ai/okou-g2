import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'

import App from './App'
import './styles.css'

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const root = createRoot(document.getElementById('root')!)

if (!publishableKey) {
  root.render(
    <div className="fatal">
      Missing <code>VITE_CLERK_PUBLISHABLE_KEY</code> at build time.
    </div>,
  )
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    </StrictMode>,
  )
}
