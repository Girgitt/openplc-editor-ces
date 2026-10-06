import { useEffect, useRef } from 'react'

import { useProject } from '../middleware/shared/providers'
import { openPLCStoreBase, useOpenPLCStore } from '../frontend/store'
import { stlibsToSystemLibraries } from '../frontend/utils/stlib-to-system-library'
import { editorPorts } from '../middleware/editor-platform'
import { cesApi, isCesWebEnvironment } from './api'

export function CesSessionBootstrap() {
  const projectPort = useProject()
  const projectPath = useOpenPLCStore((state) => state.project.meta.path)
  const handleOpenProjectResponse = useOpenPLCStore((state) => state.sharedWorkspaceActions.handleOpenProjectResponse)
  const timer = useRef<number | undefined>()
  const attemptedProjectId = useRef<string | null>(null)
  const librariesHydrated = useRef(false)

  useEffect(() => {
    if (!isCesWebEnvironment() || projectPath) return undefined
    let cancelled = false

    const attempt = async () => {
      if (!librariesHydrated.current) {
        try {
          const [archives, installed] = await Promise.all([
            editorPorts.library.loadAll(),
            editorPorts.library.listInstalled(),
          ])
          const actions = openPLCStoreBase.getState().libraryActions
          actions.setSystemLibraries(stlibsToSystemLibraries(archives))
          actions.setBundledLibraryNames(installed.filter((item) => item.bundled).map((item) => item.name))
          librariesHydrated.current = true
        } catch {
          // Retry with the normal one-second document bootstrap cadence. A
          // missing library catalogue must not permanently race project load.
          if (!cancelled) timer.current = window.setTimeout(() => void attempt(), 1000)
          return
        }
      }

      const projectId = new URLSearchParams(window.location.search).get('project_id')?.trim() ?? ''
      if (projectId && attemptedProjectId.current !== projectId) {
        attemptedProjectId.current = projectId
        try {
          await cesApi('/api/project/open', {
            method: 'POST',
            body: JSON.stringify({ projectId }),
          })
          window.dispatchEvent(new CustomEvent('openplc-ces-project-error', { detail: '' }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          window.dispatchEvent(new CustomEvent('openplc-ces-project-error', { detail: message }))
        }
      }

      try {
        const result = await projectPort.openProjectByPath('/ces-session')
        if (!cancelled && result.success && result.data) {
          handleOpenProjectResponse(result.data)
          return
        }
      } catch {
        // Standalone project opening or CES may populate /api/document after the iframe has loaded.
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
