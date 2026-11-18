export interface SseEvent {
  data: string
}

/**
 * Incremental SSE line-buffering state machine.
 * Callers must pass already-decoded UTF-8 strings (e.g. via TextDecoder({ stream: true })).
 */
export class SseLineParser {
  private buffer = ''
  private dataLines: string[] = []
  private first = true

  push(chunk: string): SseEvent[] {
    if (chunk === '') return []
    this.buffer += chunk
    if (this.first) {
      if (this.buffer.startsWith('\uFEFF')) {
        this.buffer = this.buffer.slice(1)
      }
      this.first = false
    }

    const events: SseEvent[] = []
    this.consumeLines(false, events)
    return events
  }

  flush(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer.length > 0) {
      this.consumeLines(true, events)
      if (this.buffer.length > 0) {
        this.processLine(this.buffer, events)
        this.buffer = ''
      }
    }
    if (this.dataLines.length > 0) {
      events.push({ data: this.dataLines.join('\n') })
      this.dataLines = []
    }
    return events
  }

  private consumeLines(eof: boolean, out: SseEvent[]): void {
    const buf = this.buffer
    const len = buf.length
    let start = 0

    for (let i = 0; i < len; i++) {
      const ch = buf[i]
      if (ch === '\n') {
        this.processLine(buf.slice(start, i), out)
        start = i + 1
      } else if (ch === '\r') {
        if (i + 1 < len) {
          this.processLine(buf.slice(start, i), out)
          if (buf[i + 1] === '\n') {
            i++
          }
          start = i + 1
        } else if (eof) {
          this.processLine(buf.slice(start, i), out)
          start = i + 1
        } else {
          // Hold trailing '\r' in buffer until next chunk clarifies whether '\n' follows.
          break
        }
      }
    }

    this.buffer = buf.slice(start)
  }

  private processLine(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.dataLines.length > 0) {
        out.push({ data: this.dataLines.join('\n') })
        this.dataLines = []
      }
      return
    }

    if (line.startsWith(':')) {
      return
    }

    const colonIdx = line.indexOf(':')
    let field: string
    let value: string
    if (colonIdx === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colonIdx)
      value = line.slice(colonIdx + 1)
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
    }

    if (field === 'data') {
      this.dataLines.push(value)
    }
  }
}
