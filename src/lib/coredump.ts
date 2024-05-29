import { EngineCommandManager } from 'lang/std/engineConnection'
import { WebrtcStats } from 'wasm-lib/kcl/bindings/WebrtcStats'
import { OsInfo } from 'wasm-lib/kcl/bindings/OsInfo'
import { isTauri } from 'lib/isTauri'
import {
  platform as tauriPlatform,
  arch as tauriArch,
  version as tauriKernelVersion,
} from '@tauri-apps/plugin-os'
import { APP_VERSION } from 'routes/Settings'
import { UAParser } from 'ua-parser-js'
import screenshot from 'lib/screenshot'
import React from 'react'
import { VITE_KC_API_BASE_URL } from 'env'

// This is a class for getting all the values from the JS world to pass to the Rust world
// for a core dump.
export class CoreDumpManager {
  engineCommandManager: EngineCommandManager
  htmlRef: React.RefObject<HTMLDivElement> | null
  token: string | undefined
  baseUrl: string = VITE_KC_API_BASE_URL

  constructor(
    engineCommandManager: EngineCommandManager,
    htmlRef: React.RefObject<HTMLDivElement> | null,
    token: string | undefined
  ) {
    this.engineCommandManager = engineCommandManager
    this.htmlRef = htmlRef
    this.token = token
  }

  // Get the token.
  authToken(): string {
    if (!this.token) {
      throw new Error('Token not set')
    }
    return this.token
  }

  // Get the base url.
  baseApiUrl(): string {
    return this.baseUrl
  }

  // Get the version of the app from the package.json.
  version(): string {
    return APP_VERSION
  }

  // Get the backend pool we've requested.
  pool(): string {
    return this.engineCommandManager.pool || ''
  }

  // Get the os information.
  getOsInfo(): Promise<string> {
    if (this.isTauri()) {
      return tauriArch()
        .catch((error: any) => {
          throw new Error(`Error getting arch: ${error}`)
        })
        .then((arch: string) => {
          return tauriPlatform()
            .catch((error: any) => {
              throw new Error(`Error getting platform: ${error}`)
            })
            .then((platform: string) => {
              return tauriKernelVersion()
                .catch((error: any) => {
                  throw new Error(`Error getting kernel version: ${error}`)
                })
                .then((kernelVersion: string) => {
                  const osinfo: OsInfo = {
                    platform,
                    arch,
                    browser: 'tauri',
                    version: kernelVersion,
                  }
                  return JSON.stringify(osinfo)
                })
            })
        })
    }

    const userAgent = window.navigator.userAgent || 'unknown browser'
    if (userAgent === 'unknown browser') {
      const osinfo: OsInfo = {
        platform: userAgent,
        arch: userAgent,
        version: userAgent,
        browser: userAgent,
      }
      return new Promise((resolve) => resolve(JSON.stringify(osinfo)))
    }

    const parser = new UAParser(userAgent)
    const parserResults = parser.getResult()
    const osinfo: OsInfo = {
      platform: parserResults.os.name || userAgent,
      arch: parserResults.cpu.architecture || userAgent,
      version: parserResults.os.version || userAgent,
      browser: userAgent,
    }
    return new Promise((resolve) => resolve(JSON.stringify(osinfo)))
  }

  isTauri(): boolean {
    return isTauri()
  }

  getWebrtcStats(): Promise<string> {
    if (!this.engineCommandManager.engineConnection) {
      throw new Error('Engine connection not initialized')
    }

    if (!this.engineCommandManager.engineConnection.webrtcStatsCollector) {
      throw new Error('Engine webrtcStatsCollector not initialized')
    }

    return this.engineCommandManager.engineConnection
      .webrtcStatsCollector()
      .catch((error: any) => {
        throw new Error(`Error getting webrtc stats: ${error}`)
      })
      .then((stats: any) => {
        const webrtcStats: WebrtcStats = {
          packets_lost: stats.rtc_packets_lost,
          frames_received: stats.rtc_frames_received,
          frame_width: stats.rtc_frame_width,
          frame_height: stats.rtc_frame_height,
          frame_rate: stats.rtc_frames_per_second,
          key_frames_decoded: stats.rtc_keyframes_decoded,
          frames_dropped: stats.rtc_frames_dropped,
          pause_count: stats.rtc_pause_count,
          total_pauses_duration: stats.rtc_total_pauses_duration_sec,
          freeze_count: stats.rtc_freeze_count,
          total_freezes_duration: stats.rtc_total_freezes_duration_sec,
          pli_count: stats.rtc_pli_count,
          jitter: stats.rtc_jitter_sec,
        }
        return JSON.stringify(webrtcStats)
      })
  }

  // Currently just a placeholder to begin loading singleton and xstate data into
  getClientState(): Promise<string> {
    /**
     * Deep clone a JavaScript Object
     * - NOTE: this function thows on parse errors from things like circular references
     * - It is also syncronous and could be more performant
     * - There is a whole rabbit hole to explore here if you like.
     * - This works for our use case.
     * @param {object} obj - The object to clone.
     */
    const deepClone = (obj: any) => JSON.parse(JSON.stringify(obj))
    
    /**
     * Check if a function is private method
     */
    const isPrivateMethod = (key: string) => {
      return key.length && key[0] === '_'
    }

    console.warn('CoreDump: Gathering client state')

    // Initialize the clientState object
    let clientState = {
      // singletons
      engine_command_manager: {
        artifact_map: {},
        command_logs: [],
        engine_connection: { state: { type: '' } },
        default_planes: {},
        scene_command_artifacts: {},
      },
      kcl_manager: {
        ast: {},
        kcl_errors: [],
      },
      scene_infra: {},
      scene_entities_manager: {},
      editor_manager: {},
      // xstate
      auth_machine: {},
      command_bar_machine: {},
      file_machine: {},
      home_machine: {},
      modeling_machine: {},
      settings_machine: {},
    }
    console.log('CoreDump: initialized clientState', clientState)
    console.info('CoreDump: globalThis.window', globalThis.window)

    try {
      // Singletons

      // engine_command_manager
      console.log(
        'CoreDump: engineCommandManager',
        this.engineCommandManager
      )

      // artifact map - this.engineCommandManager.artifactMap
      if (this.engineCommandManager?.artifactMap) {
        console.log(
          'CoreDump: Engine Command Manager artifact map',
          this.engineCommandManager.artifactMap
        )
        clientState.engine_command_manager.artifact_map = deepClone(
          this.engineCommandManager.artifactMap
        )
      }

      // command logs - this.engineCommandManager.commandLogs
      if (this.engineCommandManager?.commandLogs) {
        console.log(
          'CoreDump: Engine Command Manager command logs',
          this.engineCommandManager.commandLogs
        )
        clientState.engine_command_manager.command_logs = deepClone(
          this.engineCommandManager.commandLogs
        )
      }

      // default planes - this.engineCommandManager.defaultPlanes
      if (this.engineCommandManager?.defaultPlanes) {
        console.log(
          'CoreDump: Engine Command Manager default planes',
          this.engineCommandManager.defaultPlanes
        )
        clientState.engine_command_manager.default_planes = deepClone(
          this.engineCommandManager.defaultPlanes
        )
      }

      // engine connection state
      if (this.engineCommandManager?.engineConnection?.state) {
        clientState.engine_command_manager.engine_connection.state =
          this.engineCommandManager.engineConnection.state
        console.log(
          'CoreDump: Engine Command Manager engine connection state',
          this.engineCommandManager.engineConnection.state
        )
      }

      // in sequence - this.engineCommandManager.inSequence
      if (this.engineCommandManager?.inSequence) {
        console.log(
          'CoreDump: Engine Command Manager in sequence',
          this.engineCommandManager.inSequence
        )
        clientState.engine_command_manager.in_sequence =
          this.engineCommandManager.inSequence
      }

      // out sequence - this.engineCommandManager.outSequence
      if (this.engineCommandManager?.inSequence) {
        console.log(
          'CoreDump: Engine Command Manager out sequence',
          this.engineCommandManager.outSequence
        )
        clientState.engine_command_manager.out_sequence =
          this.engineCommandManager.inSequence
      }

      // scene command artifacts - this.engineCommandManager.sceneCommandArtifacts
      if (this.engineCommandManager?.sceneCommandArtifacts) {
        console.log(
          'CoreDump: Engine Command Manager scene command artifacts',
          this.engineCommandManager.sceneCommandArtifacts
        )
        clientState.engine_command_manager.scene_command_artifacts = deepClone(
          this.engineCommandManager.sceneCommandArtifacts
        )
      }

      // KCL Manager - globalThis?.window?.kclManager
      const kclManager = globalThis?.window?.kclManager
      console.log('CoreDump: kclManager', kclManager)

      if (kclManager) {
        // KCL Manager AST
        console.log('CoreDump: KCL Manager AST', kclManager?.ast)
        if (kclManager?.ast) {
          clientState.kcl_manager.ast = deepClone(kclManager.ast)
        }

        // KCL Errors
        console.log('CoreDump: KCL Errors', kclManager?.kclErrors)
        if (kclManager?.kclErrors) {
          clientState.kcl_manager.kcl_errors = deepClone(kclManager.kclErrors)
        }

        // KCL isExecuting
        console.log('CoreDump: KCL isExecuting', kclManager?.isExecuting)
        if (kclManager?.isExecuting) {
          clientState.kcl_manager.isExecuting = kclManager.isExecuting
        }

        // KCL logs
        console.log('CoreDump: KCL logs', kclManager?.logs)
        if (kclManager?.logs) {
          clientState.kcl_manager.logs = deepClone(kclManager.logs)
        }

        // KCL programMemory
        console.log('CoreDump: KCL programMemory', kclManager?.programMemory)
        if (kclManager?.programMemory) {
          clientState.kcl_manager.programMemory = deepClone(
            kclManager.programMemory
          )
        }

        // KCL wasmInitFailed
        console.log('CoreDump: KCL wasmInitFailed', kclManager?.wasmInitFailed)
        if (kclManager?.wasmInitFailed) {
          clientState.kcl_manager.wasmInitFailed = kclManager.wasmInitFailed
        }
      }

      // Scene Infra - globalThis?.window?.sceneInfra
      const sceneInfra = globalThis?.window?.sceneInfra
      console.log('CoreDump: Scene Infra', sceneInfra)

      if (sceneInfra) {
        const sceneInfraSkipKeys = ['camControls']
        const sceneInfraKeys = Object.keys(sceneInfra)
          .sort()
          .filter((entry) => {
            return (
              typeof sceneInfra[entry] !== 'function' &&
              !sceneInfraSkipKeys.includes(entry)
            )
          })

        console.log('CoreDump: Scene Infra keys', sceneInfraKeys)
        sceneInfraKeys.forEach((key: string) => {
          console.log('CoreDump: Scene Infra', key, sceneInfra[key])
          try {
            clientState.scene_infra[key] = sceneInfra[key]
          } catch (error) {
            console.error(
              'CoreDump: unable to parse Scene Infra ' + key + ' data due to ',
              error
            )
          }
        })
      }

      // Scene Entities Manager - globalThis?.window?.sceneEntitiesManager
      const sceneEntitiesManager = globalThis?.window?.sceneEntitiesManager
      console.log('CoreDump: sceneEntitiesManager', sceneEntitiesManager)

      if (sceneEntitiesManager) {
        // Scene Entities Manager active segments
        console.log('CoreDump: Scene Entities Manager active segments', sceneEntitiesManager?.activeSegments)
        if (sceneEntitiesManager?.activeSegments) {
          clientState.scene_entities_manager.activeSegments = deepClone(sceneEntitiesManager.activeSegments)
        }
      }

      // Editor Manager - globalThis?.window?.editorManager
      const editorManager = globalThis?.window?.editorManager
      console.log('CoreDump: editorManager', editorManager)

      if (editorManager) {
        const editorManagerSkipKeys = ['camControls']
        const editorManagerKeys = Object.keys(editorManager)
          .sort()
          .filter((entry) => {
            return (
              typeof editorManager[entry] !== 'function' &&
              !isPrivateMethod(entry) &&
              !editorManagerSkipKeys.includes(entry)
            )
          })

        console.log('CoreDump: Editor Manager keys', editorManagerKeys)
        editorManagerKeys.forEach((key: string) => {
          console.log('CoreDump: Editor Manager', key, editorManager[key])
          try {
            clientState.editor_manager[key] = deepClone(editorManager[key])
          } catch (error) {
            console.error(
              'CoreDump: unable to parse Editor Manager ' + key + ' data due to ',
              error
            )
          }
        })
      }

      // enableMousePositionLogs - Not coredumped
      // See https://github.com/KittyCAD/modeling-app/issues/2338#issuecomment-2136441998
      console.log(
        'CoreDump: enableMousePositionLogs [not coredumped]',
        globalThis?.window?.enableMousePositionLogs
      )

      // XState Machines
      console.log(
        'CoreDump: xstate services',
        globalThis?.window?.__xstate__?.services
      )

      console.log('CoreDump: final clientState', clientState)

      const clientStateJson = JSON.stringify(clientState)
      console.log('CoreDump: final clientState JSON', clientStateJson)

      return Promise.resolve(clientStateJson)
    } catch (error) {
      console.error('CoreDump: unable to return data due to ', error)
      return Promise.reject(JSON.stringify(error))
    }
  }

  // Return a data URL (png format) of the screenshot of the current page.
  screenshot(): Promise<string> {
    return screenshot(this.htmlRef)
      .then((screenshot: string) => {
        return screenshot
      })
      .catch((error: any) => {
        throw new Error(`Error getting screenshot: ${error}`)
      })
  }
}
