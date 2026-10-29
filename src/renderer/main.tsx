import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CrashNet, armGlobalNets } from './CrashNet'
import YirStoryExportApp from './components/yir/YirStoryExport'

// Arm before first render: a crash during mount is exactly the kind of
// death that used to leave a silent grey screen.
armGlobalNets()

// The Year in Review's Instagram Story frames render in their own hidden window
// (src/main/yir-export.ts), with only the story frame on the page.
const yirExport = location.hash.startsWith('#yir-export')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrashNet>
      {yirExport ? <YirStoryExportApp /> : <App />}
    </CrashNet>
  </React.StrictMode>
)
