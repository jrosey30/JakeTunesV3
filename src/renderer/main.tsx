import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CrashNet, armGlobalNets } from './CrashNet'

// Arm before first render: a crash during mount is exactly the kind of
// death that used to leave a silent grey screen.
armGlobalNets()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrashNet>
      <App />
    </CrashNet>
  </React.StrictMode>
)
