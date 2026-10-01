import '../frontend/locales/i18n'

import { installCesWebBridge } from './bridge'

installCesWebBridge()

// App imports the Electron-oriented adapters at module evaluation time. The
// REST-backed bridge must therefore exist before the shared renderer is loaded.
void import('./render')
