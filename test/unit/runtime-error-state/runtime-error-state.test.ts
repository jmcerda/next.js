import {
  createRuntimeErrorStateHandler,
  formatRuntimeErrors,
  setStackFrameResolver,
} from '../../../packages/next/src/server/dev/runtime-error-state'
import {
  HMR_MESSAGE_SENT_TO_BROWSER,
  HMR_MESSAGE_SENT_TO_SERVER,
  type FormattedRuntimeError,
  type RuntimeErrorStateError,
  type RuntimeErrorStateUpdate,
} from '../../../packages/next/src/server/dev/hot-reloader-types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function runtimeError(
  id: number,
  message: string,
  fatal = true
): RuntimeErrorStateError {
  return {
    id,
    error: { name: 'Error', message, stack: `Error: ${message}` },
    frames: [],
    type: 'runtime',
    isFatal: fatal,
  }
}

function update(
  pathname: string,
  errors: readonly RuntimeErrorStateError[] = []
): RuntimeErrorStateUpdate {
  return {
    event: HMR_MESSAGE_SENT_TO_SERVER.RUNTIME_ERROR_STATE,
    clientId: 42,
    pathname,
    errorState: {
      errors,
      routerType: 'app',
    },
  }
}

function formattedError(message: string, fatal = true): FormattedRuntimeError {
  return {
    type: 'runtime',
    errorName: 'Error',
    message,
    fatal,
    stack: [],
  }
}

describe('runtime error state handler', () => {
  it('only broadcasts the latest asynchronously formatted state', async () => {
    const first = deferred<FormattedRuntimeError[]>()
    const second = deferred<FormattedRuntimeError[]>()
    const format = jest
      .fn<
        ReturnType<typeof formatRuntimeErrors>,
        Parameters<typeof formatRuntimeErrors>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const send = jest.fn()
    const handler = createRuntimeErrorStateHandler(send, format)

    const firstPending = handler.handle(
      update('/old', [runtimeError(1, 'old')])
    )
    const secondPending = handler.handle(
      update('/new', [runtimeError(2, 'new')])
    )

    second.resolve([formattedError('new')])
    await secondPending
    first.resolve([formattedError('old')])
    await firstPending

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: HMR_MESSAGE_SENT_TO_BROWSER.RUNTIME_ERROR_STATE,
      clientId: 42,
      pathname: '/new',
      errors: [formattedError('new')],
    })
  })

  it('drops in-flight state after the socket is disposed', async () => {
    const pending = deferred<FormattedRuntimeError[]>()
    const format = jest.fn(() => pending.promise)
    const send = jest.fn()
    const handler = createRuntimeErrorStateHandler(send, format)

    const handling = handler.handle(
      update('/disconnected', [runtimeError(1, 'stale')])
    )
    handler.dispose()
    pending.resolve([formattedError('stale')])
    await handling

    expect(send).not.toHaveBeenCalled()
  })

  it('retries formatting after a transient failure', async () => {
    const format = jest
      .fn<
        ReturnType<typeof formatRuntimeErrors>,
        Parameters<typeof formatRuntimeErrors>
      >()
      .mockRejectedValueOnce(new Error('transient formatting failure'))
      .mockResolvedValueOnce([formattedError('retry')])
    const send = jest.fn()
    const handler = createRuntimeErrorStateHandler(send, format)
    const state = update('/retry', [runtimeError(1, 'retry')])

    await expect(handler.handle(state)).rejects.toThrow(
      'transient formatting failure'
    )
    await expect(handler.handle(state)).resolves.toBeUndefined()

    expect(format).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith({
      type: HMR_MESSAGE_SENT_TO_BROWSER.RUNTIME_ERROR_STATE,
      clientId: 42,
      pathname: '/retry',
      errors: [formattedError('retry')],
    })
  })

  it('formats each unchanged error only once across full snapshots', async () => {
    const format = jest.fn(async (errors: readonly RuntimeErrorStateError[]) =>
      errors.map((error) =>
        formattedError(error.error?.message || 'Unknown error', error.isFatal)
      )
    )
    const send = jest.fn()
    const handler = createRuntimeErrorStateHandler(send, format)
    const first = runtimeError(1, 'first')
    const second = runtimeError(2, 'second')

    await handler.handle(update('/first', [first]))
    await handler.handle(update('/second', [first, second]))
    await handler.handle(update('/replay', [first, second]))

    expect(format).toHaveBeenCalledTimes(2)
    expect(format.mock.calls[0][0]).toEqual([first])
    expect(format.mock.calls[1][0]).toEqual([second])
    expect(send).toHaveBeenLastCalledWith({
      type: HMR_MESSAGE_SENT_TO_BROWSER.RUNTIME_ERROR_STATE,
      clientId: 42,
      pathname: '/replay',
      errors: [formattedError('first'), formattedError('second')],
    })
  })

  it('shares in-flight formatting between superseding snapshots', async () => {
    const first = deferred<FormattedRuntimeError[]>()
    const second = deferred<FormattedRuntimeError[]>()
    const format = jest
      .fn<
        ReturnType<typeof formatRuntimeErrors>,
        Parameters<typeof formatRuntimeErrors>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const send = jest.fn()
    const handler = createRuntimeErrorStateHandler(send, format)
    const firstError = runtimeError(1, 'first')
    const secondError = runtimeError(2, 'second')

    const firstPending = handler.handle(update('/first', [firstError]))
    const secondPending = handler.handle(
      update('/second', [firstError, secondError])
    )

    expect(format.mock.calls[0][0]).toEqual([firstError])
    expect(format.mock.calls[1][0]).toEqual([secondError])

    second.resolve([formattedError('second')])
    first.resolve([formattedError('first')])
    await Promise.all([firstPending, secondPending])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: HMR_MESSAGE_SENT_TO_BROWSER.RUNTIME_ERROR_STATE,
      clientId: 42,
      pathname: '/second',
      errors: [formattedError('first'), formattedError('second')],
    })
  })

  it('formats a growing error list in linear work', async () => {
    let formattedCount = 0
    const format = jest.fn(
      async (errors: readonly RuntimeErrorStateError[]) => {
        formattedCount += errors.length
        return errors.map((error) =>
          formattedError(error.error?.message || 'Unknown error', error.isFatal)
        )
      }
    )
    const handler = createRuntimeErrorStateHandler(jest.fn(), format)
    const errors = Array.from({ length: 100 }, (_, index) =>
      runtimeError(index, `error ${index}`)
    )

    for (let length = 1; length <= errors.length; length++) {
      await handler.handle(update('/stress', errors.slice(0, length)))
    }

    expect(formattedCount).toBe(errors.length)
  })

  it('reformats a promoted error whose fatality changed', async () => {
    const format = jest.fn(async (errors: readonly RuntimeErrorStateError[]) =>
      errors.map((error) =>
        formattedError(error.error?.message || 'Unknown error', error.isFatal)
      )
    )
    const handler = createRuntimeErrorStateHandler(jest.fn(), format)

    await handler.handle(update('/caught', [runtimeError(1, 'shared', false)]))
    await handler.handle(update('/fatal', [runtimeError(1, 'shared', true)]))

    expect(format).toHaveBeenCalledTimes(2)
    expect(format.mock.calls[1][0]).toEqual([runtimeError(1, 'shared', true)])
  })

  it('keeps fallback frames aligned after filtering ignored frames', async () => {
    const error = runtimeError(1, 'mixed frames')
    error.frames = [
      {
        file: 'ignored.js',
        methodName: 'ignored',
        line1: 1,
        column1: 1,
      },
      {
        file: 'compiled.js',
        methodName: 'resolved',
        line1: 2,
        column1: 2,
      },
      {
        file: 'fallback.js',
        methodName: 'fallback',
        line1: 3,
        column1: 3,
      },
    ]
    setStackFrameResolver(async () => [
      {
        status: 'fulfilled',
        value: {
          originalStackFrame: {
            file: 'ignored.ts',
            methodName: 'ignored',
            arguments: [],
            line1: 10,
            column1: 10,
            ignored: true,
          },
          originalCodeFrame: null,
        },
      },
      {
        status: 'fulfilled',
        value: {
          originalStackFrame: {
            file: 'resolved.ts',
            methodName: 'resolved',
            arguments: [],
            line1: 20,
            column1: 20,
            ignored: false,
          },
          originalCodeFrame: null,
        },
      },
      { status: 'rejected', reason: new Error('unresolved') },
    ])

    await expect(formatRuntimeErrors([error], true)).resolves.toEqual([
      {
        ...formattedError('mixed frames'),
        stack: [
          {
            file: 'resolved.ts',
            methodName: 'resolved',
            line: 20,
            column: 20,
          },
          {
            file: 'fallback.js',
            methodName: 'fallback',
            line: 3,
            column: 3,
          },
        ],
      },
    ])
  })

  it('formats unvalidated errors without frames', async () => {
    const error = runtimeError(1, 'missing frames')
    Reflect.deleteProperty(error, 'frames')

    await expect(formatRuntimeErrors([error], true)).resolves.toEqual([
      formattedError('missing frames'),
    ])
  })

  it('ignores malformed client messages', async () => {
    const format = jest.fn()
    const send = jest.fn()
    const handler = createRuntimeErrorStateHandler(send, format)

    await expect(
      handler.handle({
        event: HMR_MESSAGE_SENT_TO_SERVER.RUNTIME_ERROR_STATE,
      })
    ).resolves.toBeUndefined()
    await expect(
      handler.handle({
        ...update('/safe'),
        pathname: '/safe?token=secret',
      })
    ).resolves.toBeUndefined()

    expect(format).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
