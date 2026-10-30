// Development only: a fetch whose URL has no scheme (a relative path, `undefined/…`) fails in
// expo/fetch's native side as "the 2nd argument cannot be cast to type class java.net.URL", which
// names neither the URL nor the caller. Log both to the Metro terminal before it fails.

if (__DEV__) {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(String(url))) {
      console.warn(`[playpex] fetch without a scheme: ${JSON.stringify(url)}\n${new Error().stack ?? ''}`)
    }
    return original(input, init)
  }) as typeof fetch
}

export {}
