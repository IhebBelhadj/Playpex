// Switch view (docs/web-unified-plan.md §5): only in a browser (viewSwitch.web.ts); a phone has
// one view

export async function tvViewAvailable(): Promise<boolean> {
  return false
}

export function switchToTvView(_at: string): void {}
