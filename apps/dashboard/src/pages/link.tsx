import { Check, KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { PageHeader, QueryError, Spinner } from '@/components/common'
import { usePairingRequests } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { formatCode, PairingRequests, usePairingDecision } from './devices'

// /link: pairing's verification_uri (RFC 8628). A client shows a code and a
// QR code of /link?user_code=…; the admin signs in (RequireAdmin) and approves.
export function LinkPage() {
  const [params] = useSearchParams()
  const fromQr = params.get('user_code') ?? ''
  const [code, setCode] = useState(formatCode(fromQr))
  const [done, setDone] = useState<string | null>(null)
  const pairing = usePairingRequests()
  const decide = usePairingDecision()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const c = code.replace(/[^a-z0-9]/gi, '')
    decide.mutate({ code: c, approve: true }, { onSuccess: () => setDone(formatCode(c)) })
  }

  return (
    <>
      <PageHeader title="Link a device" description="Type the code your TV, phone or other client shows." />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> Code
          </CardTitle>
          <CardDescription>Codes are valid for a few minutes. Letters and digits, with or without the dash.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-3 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-success/15 text-success">
                <Check />
              </div>
              <p>
                <span className="font-mono">{done}</span> approved. The device connects on its own within a few seconds.
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="outline" onClick={() => { setDone(null); setCode('') }}>
                  Link another
                </Button>
                <Button asChild>
                  <Link to="/devices">See devices</Link>
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
              <Input
                aria-label="Code"
                className="h-12 text-center font-mono text-2xl tracking-[0.3em] uppercase"
                placeholder="ABCD-EFGH"
                value={code}
                maxLength={9}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <Button type="submit" className="h-12 sm:w-32" disabled={decide.isPending || code.replace(/[^a-z0-9]/gi, '').length < 8}>
                {decide.isPending ? <Spinner /> : <Check />} Approve
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
        </CardHeader>
        <CardContent>
          {pairing.error ? <QueryError error={pairing.error} /> : pairing.data ? <PairingRequests requests={pairing.data} highlight={code} /> : <Spinner />}
        </CardContent>
      </Card>
    </>
  )
}
