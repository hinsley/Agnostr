import type {
  ContentFilterWorkerInMessage,
  ContentFilterWorkerOutMessage,
} from './contentFilter.worker.ts'

type WorkerRequest = Extract<ContentFilterWorkerInMessage, { requestId: string }>
type WorkerStatus = Extract<ContentFilterWorkerOutMessage, { type: 'status' }>

interface Pending {
  resolve: (message: ContentFilterWorkerOutMessage) => void
  reject: (error: Error) => void
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000

/** Own one worker generation and all requests made to it. Fatal errors must not
 * leave a dead Worker cached for the settings screen's Reload Model action. */
export class ContentFilterWorkerClient {
  private worker: Worker | null = null
  private pending = new Map<string, Pending>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private createWorker: () => Worker
  private onStatus: (status: WorkerStatus) => void
  private onCrash: (message: string) => void
  private timeoutMs: number

  constructor(
    createWorker: () => Worker,
    onStatus: (status: WorkerStatus) => void,
    onCrash: (message: string) => void,
    timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  ) {
    this.createWorker = createWorker
    this.onStatus = onStatus
    this.onCrash = onCrash
    this.timeoutMs = timeoutMs
  }

  get running(): boolean {
    return this.worker !== null
  }

  request(payload: WorkerRequest): Promise<ContentFilterWorkerOutMessage> {
    return new Promise((resolve, reject) => {
      if (this.pending.has(payload.requestId)) {
        reject(new Error('Duplicate content filter request.'))
        return
      }

      this.pending.set(payload.requestId, { resolve, reject })
      try {
        const worker = this.worker ?? this.start()
        worker.postMessage(payload)
        this.armTimer(worker)
      } catch (error) {
        this.crash(error instanceof Error ? error.message : 'Unable to start the content filter worker.')
      }
    })
  }

  reset(message = 'Content filter worker reset.'): void {
    this.clearTimer()
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const job of pending) job.reject(new Error(message))
  }

  private start(): Worker {
    const worker = this.createWorker()
    this.worker = worker
    worker.onmessage = (event: MessageEvent<ContentFilterWorkerOutMessage>) => {
      if (this.worker !== worker) return
      const msg = event.data
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'status') {
        this.armTimer(worker)
        this.onStatus(msg)
        return
      }
      if (msg.type === 'result' || msg.type === 'cache-cleared' || msg.type === 'error') {
        const job = this.pending.get(msg.requestId)
        if (!job) return
        this.pending.delete(msg.requestId)
        this.armTimer(worker)
        if (msg.type === 'error') {
          job.reject(new Error(msg.error || 'Image safety filtering error.'))
        } else {
          job.resolve(msg)
        }
      }
    }
    worker.onerror = (event) => {
      if (this.worker === worker) {
        this.crash(event.message || 'The content filter could not start. Try Reload Model; if it still fails, reopen Agnostr to load the latest app version.')
      }
    }
    worker.onmessageerror = () => {
      if (this.worker === worker) this.crash('The content filter returned an unreadable response.')
    }
    return worker
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private armTimer(worker: Worker): void {
    this.clearTimer()
    if (this.pending.size === 0) return
    this.timer = setTimeout(() => {
      if (this.worker === worker) this.crash('The content filter stopped responding. Try Reload Model.')
    }, this.timeoutMs)
  }

  private crash(message: string): void {
    this.reset(message)
    this.onCrash(message)
  }
}
