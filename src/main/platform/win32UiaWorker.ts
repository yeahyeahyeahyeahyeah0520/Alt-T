import { isMainThread, parentPort } from 'node:worker_threads'
import {
  walkFocusedElementChainNative,
  type UiaWorkerReply,
  type UiaWorkerRequest
} from './win32Uia'

if (!isMainThread && parentPort) {
  parentPort.on('message', (raw: unknown) => {
    const req = raw as Partial<UiaWorkerRequest> | null
    if (!req || typeof req.id !== 'number' || typeof req.targetPid !== 'number') {
      return
    }
    try {
      const res = walkFocusedElementChainNative(req.targetPid)
      const reply: UiaWorkerReply = {
        id: req.id,
        ok: res.ok,
        nodes: res.nodes,
        ...(res.error ? { error: res.error } : {})
      }
      parentPort?.postMessage(reply)
    } catch (err) {
      const reply: UiaWorkerReply = {
        id: req.id,
        ok: false,
        nodes: [],
        error: err instanceof Error ? err.message : String(err)
      }
      parentPort?.postMessage(reply)
    }
  })
}
