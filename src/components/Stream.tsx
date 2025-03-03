import { MouseEventHandler, useEffect, useRef, useState } from 'react'
import { getNormalisedCoordinates } from '../lib/utils'
import Loading from './Loading'
import { useSettingsAuthContext } from 'hooks/useSettingsAuthContext'
import { useModelingContext } from 'hooks/useModelingContext'
import { useNetworkContext } from 'hooks/useNetworkContext'
import { NetworkHealthState } from 'hooks/useNetworkStatus'
import { ClientSideScene } from 'clientSideScene/ClientSideSceneComp'
import { btnName } from 'lib/cameraControls'
import { sendSelectEventToEngine } from 'lib/selections'
import { kclManager, engineCommandManager, sceneInfra } from 'lib/singletons'
import { useAppStream } from 'AppState'
import {
  EngineConnectionStateType,
  DisconnectingType,
} from 'lang/std/engineConnection'

export const Stream = () => {
  const [isLoading, setIsLoading] = useState(true)
  const [isFirstRender, setIsFirstRender] = useState(kclManager.isFirstRender)
  const [clickCoords, setClickCoords] = useState<{ x: number; y: number }>()
  const videoRef = useRef<HTMLVideoElement>(null)
  const { settings } = useSettingsAuthContext()
  const { state, send, context } = useModelingContext()
  const { mediaStream } = useAppStream()
  const { overallState, immediateState } = useNetworkContext()
  const [isFreezeFrame, setIsFreezeFrame] = useState(false)
  const [isPaused, setIsPaused] = useState(false)

  const IDLE = settings.context.app.streamIdleMode.current

  const isNetworkOkay =
    overallState === NetworkHealthState.Ok ||
    overallState === NetworkHealthState.Weak

  useEffect(() => {
    if (
      immediateState.type === EngineConnectionStateType.Disconnecting &&
      immediateState.value.type === DisconnectingType.Pause
    ) {
      setIsPaused(true)
    }
    if (immediateState.type === EngineConnectionStateType.Connecting) {
      setIsPaused(false)
    }
  }, [immediateState])

  // Linux has a default behavior to paste text on middle mouse up
  // This adds a listener to block that pasting if the click target
  // is not a text input, so users can move in the 3D scene with
  // middle mouse drag with a text input focused without pasting.
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const isHtmlElement = e.target && e.target instanceof HTMLElement
      const isEditable =
        (isHtmlElement && !('explicitOriginalTarget' in e)) ||
        ('explicitOriginalTarget' in e &&
          ((e.explicitOriginalTarget as HTMLElement).contentEditable ===
            'true' ||
            ['INPUT', 'TEXTAREA'].some(
              (tagName) =>
                tagName === (e.explicitOriginalTarget as HTMLElement).tagName
            )))
      if (!isEditable) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
      }
    }

    globalThis?.window?.document?.addEventListener('paste', handlePaste, {
      capture: true,
    })

    const IDLE_TIME_MS = 1000 * 60 * 2
    let timeoutIdIdleA: ReturnType<typeof setTimeout> | undefined = undefined

    const teardown = () => {
      videoRef.current?.pause()
      setIsFreezeFrame(true)
      sceneInfra.modelingSend({ type: 'Cancel' })
      // Give video time to pause
      window.requestAnimationFrame(() => {
        engineCommandManager.tearDown({ idleMode: true })
      })
    }

    const onVisibilityChange = () => {
      if (globalThis.window.document.visibilityState === 'hidden') {
        clearTimeout(timeoutIdIdleA)
        timeoutIdIdleA = setTimeout(teardown, IDLE_TIME_MS)
      } else if (!engineCommandManager.engineConnection?.isReady()) {
        clearTimeout(timeoutIdIdleA)
        engineCommandManager.engineConnection?.connect(true)
      }
    }

    // Teardown everything if we go hidden or reconnect
    if (IDLE) {
      globalThis?.window?.document?.addEventListener(
        'visibilitychange',
        onVisibilityChange
      )
    }

    let timeoutIdIdleB: ReturnType<typeof setTimeout> | undefined = undefined

    const onAnyInput = () => {
      // Clear both timers
      clearTimeout(timeoutIdIdleA)
      clearTimeout(timeoutIdIdleB)
      timeoutIdIdleB = setTimeout(teardown, IDLE_TIME_MS)
    }

    if (IDLE) {
      globalThis?.window?.document?.addEventListener('keydown', onAnyInput)
      globalThis?.window?.document?.addEventListener('mousemove', onAnyInput)
      globalThis?.window?.document?.addEventListener('mousedown', onAnyInput)
      globalThis?.window?.document?.addEventListener('scroll', onAnyInput)
      globalThis?.window?.document?.addEventListener('touchstart', onAnyInput)
    }

    if (IDLE) {
      timeoutIdIdleB = setTimeout(teardown, IDLE_TIME_MS)
    }

    return () => {
      globalThis?.window?.document?.removeEventListener('paste', handlePaste, {
        capture: true,
      })
      if (IDLE) {
        clearTimeout(timeoutIdIdleA)
        clearTimeout(timeoutIdIdleB)

        globalThis?.window?.document?.removeEventListener(
          'visibilitychange',
          onVisibilityChange
        )
        globalThis?.window?.document?.removeEventListener('keydown', onAnyInput)
        globalThis?.window?.document?.removeEventListener(
          'mousemove',
          onAnyInput
        )
        globalThis?.window?.document?.removeEventListener(
          'mousedown',
          onAnyInput
        )
        globalThis?.window?.document?.removeEventListener('scroll', onAnyInput)
        globalThis?.window?.document?.removeEventListener(
          'touchstart',
          onAnyInput
        )
      }
    }
  }, [IDLE])

  useEffect(() => {
    setIsFirstRender(kclManager.isFirstRender)
    if (!kclManager.isFirstRender) videoRef.current?.play()
    setIsFreezeFrame(!kclManager.isFirstRender)
  }, [kclManager.isFirstRender])

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof RTCPeerConnection === 'undefined'
    )
      return
    if (!videoRef.current) return
    if (!mediaStream) return

    // Do not immediately play the stream!
    videoRef.current.srcObject = mediaStream
    videoRef.current.pause()

    send({
      type: 'Set context',
      data: {
        videoElement: videoRef.current,
      },
    })

    setIsLoading(false)
  }, [mediaStream])

  const handleMouseDown: MouseEventHandler<HTMLDivElement> = (e) => {
    if (!isNetworkOkay) return
    if (!videoRef.current) return
    if (state.matches('Sketch')) return
    if (state.matches('Sketch no face')) return

    const { x, y } = getNormalisedCoordinates({
      clientX: e.clientX,
      clientY: e.clientY,
      el: videoRef.current,
      ...context.store?.streamDimensions,
    })

    send({
      type: 'Set context',
      data: {
        buttonDownInStream: e.button,
      },
    })
    setClickCoords({ x, y })
  }

  const handleMouseUp: MouseEventHandler<HTMLDivElement> = (e) => {
    if (!isNetworkOkay) return
    if (!videoRef.current) return
    send({
      type: 'Set context',
      data: {
        buttonDownInStream: undefined,
      },
    })
    if (state.matches('Sketch')) return
    if (state.matches('Sketch no face')) return

    if (!context.store?.didDragInStream && btnName(e).left) {
      sendSelectEventToEngine(
        e,
        videoRef.current,
        context.store?.streamDimensions
      )
    }

    send({
      type: 'Set context',
      data: {
        didDragInStream: false,
      },
    })
    setClickCoords(undefined)
  }

  const handleMouseMove: MouseEventHandler<HTMLVideoElement> = (e) => {
    if (!isNetworkOkay) return
    if (state.matches('Sketch')) return
    if (state.matches('Sketch no face')) return
    if (!clickCoords) return

    const delta =
      ((clickCoords.x - e.clientX) ** 2 + (clickCoords.y - e.clientY) ** 2) **
      0.5

    if (delta > 5 && !context.store?.didDragInStream) {
      send({
        type: 'Set context',
        data: {
          didDragInStream: true,
        },
      })
    }
  }

  return (
    <div
      className="absolute inset-0 z-0"
      id="stream"
      data-testid="stream"
      onMouseUp={handleMouseUp}
      onMouseDown={handleMouseDown}
      onContextMenu={(e) => e.preventDefault()}
      onContextMenuCapture={(e) => e.preventDefault()}
    >
      <video
        ref={videoRef}
        muted
        autoPlay
        controls={false}
        onPlay={() => setIsLoading(false)}
        onMouseMoveCapture={handleMouseMove}
        className="w-full cursor-pointer h-full"
        disablePictureInPicture
        id="video-stream"
      />
      <ClientSideScene
        cameraControls={settings.context.modeling.mouseControls.current}
      />
      {isPaused && (
        <div className="text-center absolute inset-0">
          <div
            className="flex flex-col items-center justify-center h-screen"
            data-testid="paused"
          >
            <div className="border-primary border p-2 rounded-sm">
              <svg
                width="8"
                height="12"
                viewBox="0 0 8 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M2 12V0H0V12H2ZM8 12V0H6V12H8Z"
                  fill="var(--primary)"
                />
              </svg>
            </div>
            <p className="text-base mt-2 text-primary bold">Paused</p>
          </div>
        </div>
      )}
      {(!isNetworkOkay || isLoading || isFirstRender) && !isFreezeFrame && (
        <div className="text-center absolute inset-0">
          <Loading>
            {!isNetworkOkay && !isLoading ? (
              <span data-testid="loading-stream">Stream disconnected...</span>
            ) : !isLoading && isFirstRender ? (
              <span data-testid="loading-stream">Building scene...</span>
            ) : (
              <span data-testid="loading-stream">Loading stream...</span>
            )}
          </Loading>
        </div>
      )}
    </div>
  )
}
