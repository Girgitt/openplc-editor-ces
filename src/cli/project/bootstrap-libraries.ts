/** Initialize exactly the IEC library pool the interactive editor loads.
 *
 * Imported PLCopen blocks carry pin names, not typed signatures. The shared
 * `handleOpenProjectResponse` restamp requires `libraries.system` to be ready
 * before the project is opened. Both CLI `import-plcopen` and `compile` call
 * `loadProject`, so the bootstrap is repeated for each headless process.
 */
import { LibraryManagerModule } from '@root/backend/editor/library-manager'
import { openPLCStoreBase } from '@root/frontend/store'
import { stlibsToSystemLibraries } from '@root/frontend/utils/stlib-to-system-library'

export function bootstrapHeadlessSystemLibraries(): number {
  const archives = new LibraryManagerModule().loadAll()
  const libraries = stlibsToSystemLibraries(archives)
  openPLCStoreBase.getState().libraryActions.setSystemLibraries(libraries)
  return libraries.length
}
