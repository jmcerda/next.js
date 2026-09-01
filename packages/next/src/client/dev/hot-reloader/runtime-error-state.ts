import {
  getSerializedOverlayState,
  subscribeToRuntimeErrorState,
} from 'next/dist/compiled/next-devtools'
import {
  HMR_MESSAGE_SENT_TO_SERVER,
  type RuntimeErrorStateUpdate,
} from '../../../server/dev/hot-reloader-types'

let reportCurrentState: (() => void) | undefined

export function reportCurrentRuntimeErrorState(): void {
  reportCurrentState?.()
}

export function createRuntimeErrorStateReporter(
  sendMessage: (message: string) => void,
  getClientId: () => number
) {
  let lastSerializedState: string | null = null

  const report = (
    errorState: RuntimeErrorStateUpdate['errorState'],
    force = false
  ) => {
    const pathname = window.location.pathname
    const serializedState = JSON.stringify({ pathname, errorState })
    if (!force && serializedState === lastSerializedState) {
      return
    }
    lastSerializedState = serializedState

    const update: RuntimeErrorStateUpdate = {
      event: HMR_MESSAGE_SENT_TO_SERVER.RUNTIME_ERROR_STATE,
      clientId: getClientId(),
      pathname,
      errorState,
    }
    sendMessage(JSON.stringify(update))
  }

  const unsubscribe = subscribeToRuntimeErrorState(
    (state: RuntimeErrorStateUpdate['errorState']) => report(state)
  )

  const reportCurrent = (force: boolean) => {
    const state = getSerializedOverlayState()
    if (state) {
      report({ errors: state.errors, routerType: state.routerType }, force)
    }
  }
  const reportOnNavigation = () => reportCurrent(false)
  reportCurrentState = reportOnNavigation

  return {
    reportCurrent(): void {
      reportCurrent(true)
    },
    dispose(): void {
      unsubscribe()
      if (reportCurrentState === reportOnNavigation) {
        reportCurrentState = undefined
      }
    },
  }
}
