import { useFonts } from 'expo-font'
import { color } from '../ui/theme'

// In a browser (docs/mobile-web-plan.md): the page set up as an app, and the app's fonts.
//
//   - app.json's embedded fonts don't exist here: the same families (ui/theme.ts `font`, named by
//     file as Android names them) load with the page; one that fails leaves the browser's own
//   - no scrollbars (a phone shows none; on a computer the window's would sit over the pictures),
//     no focus ring around text fields (the app draws its own field), the app's black behind it,
//     no pull-to-refresh or bounce of the whole page

function setUpPage(): void {
  if (typeof document === 'undefined' || document.getElementById('playpex-page')) return
  const style = document.createElement('style')
  style.id = 'playpex-page'
  style.textContent = `
    html, body { background-color: ${color.bg}; overscroll-behavior: none; }
    * { scrollbar-width: none; -webkit-tap-highlight-color: transparent; }
    *::-webkit-scrollbar { display: none; }
    input, textarea { outline: none; }
  `
  document.head.appendChild(style)
  let theme = document.querySelector('meta[name="theme-color"]')
  if (!theme) {
    theme = document.createElement('meta')
    theme.setAttribute('name', 'theme-color')
    document.head.appendChild(theme)
  }
  theme.setAttribute('content', color.bg)
}

export function usePageReady(): boolean {
  setUpPage()
  const [loaded, error] = useFonts({
    'Futura-Bold': require('../../assets/fonts/Futura-Bold.ttf'),
    'Futura-Book': require('../../assets/fonts/Futura-Book.ttf'),
    'HankenGrotesk-Regular': require('../../assets/fonts/HankenGrotesk-Regular.ttf'),
    'HankenGrotesk-Medium': require('../../assets/fonts/HankenGrotesk-Medium.ttf'),
    'HankenGrotesk-SemiBold': require('../../assets/fonts/HankenGrotesk-SemiBold.ttf'),
  })
  return loaded || !!error
}
