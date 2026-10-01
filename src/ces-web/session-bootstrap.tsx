import { useEffect, useRef } from 'react'

import { useProject } from '../middleware/shared/providers'
import { useOpenPLCStore } from '../frontend/store'
import { isCesWebEnvironment } from './api'

export function CesSessionBootstrap() {
  const projectPort = useProject()
  const projectPath = useOpenPLCStore((state) => state.project.meta.path)
  const handleOpenProjectResponse = useOpenPLCStore((state) => state.sharedWorkspaceActions.handleOpenProjectResponse)
  const timer = useRef<number | undefined>()

  useEffect(() => {
    if (!isCesWebEnvironment() || projectPath) return undefined
    let cancelled = false

    const attempt = async () => {
      try {
        const result = await projectPort.openProjectByPath('ces-session')
        if (!cancelled && result.success && result.data) {
          handleOpenProjectResponse(result.data)
          return
        }
      } catch {
        // CES may populate /api/document after the iframe has loaded.
      }
      if (!cancelled) timer.current = window.setTimeout(() => void attempt(), 1000)
    }

    void attempt()
    return () => {
      cancelled = true
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [projectPath, projectPort, handleOpenProjectResponse])

  return null
}
