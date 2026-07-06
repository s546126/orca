import type { PluginService } from './plugin-service'

/** Subset of Electron's dialog.showMessageBox, injected so this module stays
 *  Electron-free and the prompt flow is testable without a display. */
export type PluginConsentMessageBox = (options: {
  type: 'question'
  buttons: string[]
  defaultId: number
  cancelId: number
  title: string
  message: string
  detail: string
}) => Promise<{ response: number }>

/** Asks the user once per newly discovered plugin whether to enable it.
 *  Desktop-only: headless serve keeps pending plugins inert until an explicit
 *  plugins.setEnabled RPC call. Either answer is persisted, so the prompt
 *  never nags on later launches. */
export async function promptForPendingPlugins(input: {
  pluginService: PluginService
  showMessageBox: PluginConsentMessageBox
  applyEnablement: (pluginId: string, enabled: boolean) => Promise<unknown>
}): Promise<void> {
  await input.pluginService.whenReady()
  const pending = input.pluginService.listPlugins().filter((plugin) => plugin.status === 'pending')
  for (const plugin of pending) {
    const { response } = await input.showMessageBox({
      type: 'question',
      buttons: ['Enable Plugin', 'Keep Disabled'],
      // Why: enabling runs third-party code with full system access, so the
      // safe answer (and Esc) must be the default.
      defaultId: 1,
      cancelId: 1,
      title: 'New Orca plugin found',
      message: `Enable plugin "${plugin.name}"?`,
      detail:
        `Version ${plugin.version} (${plugin.pluginId}) was found in your plugins folder. ` +
        'Plugins run with the same system access as Orca itself — only enable plugins you trust.'
    })
    await input.applyEnablement(plugin.pluginId, response === 0)
  }
}
