// qrcode ships no types, and @types/qrcode would pull @types/node into the TV app's build (it
// imports qrcode too, with an older TypeScript): the part the dashboard uses
declare module 'qrcode' {
  interface ToDataUrlOptions {
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    color?: { dark?: string; light?: string }
  }
  const QRCode: { toDataURL(text: string, options?: ToDataUrlOptions): Promise<string> }
  export default QRCode
}
