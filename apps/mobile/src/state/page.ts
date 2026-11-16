// The app's fonts are embedded in the app itself on a phone (app.json's expo-font plugin): nothing to
// wait for. In a browser they load with the page, and the page is set up for an app (page.web.ts).
export function usePageReady(): boolean {
  return true
}
