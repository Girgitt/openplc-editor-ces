import { createRoot } from 'react-dom/client'

import App from '../App'
import { installMonacoCancellationGuard } from '../frontend/utils/monaco-cancellation'

installMonacoCancellationGuard()

const container = document.getElementById('root') as HTMLElement
createRoot(container).render(<App />)
postMessage({ payload: 'removeLoading' }, '*')
