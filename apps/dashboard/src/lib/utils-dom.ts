/** Copies text; false when the browser refuses (http on another host has no clipboard API). */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
