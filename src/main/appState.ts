let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function setQuitting(v: boolean): void {
  quitting = v
}
