import { useState } from 'react'
import { KeyRound } from 'lucide-react'

import { Logo } from '@/components/Logo'
import { BorderBeam } from '@/components/ui/border-beam'
import { Button } from '@/components/ui/button'
import { DotPattern } from '@/components/ui/dot-pattern'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'

export function Login() {
  const { signIn, message } = useSession()
  const [value, setValue] = useState('')
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <DotPattern
        width={18}
        height={18}
        className={cn('text-foreground/15 [mask-image:radial-gradient(420px_circle_at_center,white,transparent)]')}
      />
      <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border bg-card p-8 shadow-xl shadow-brand/5">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo className="size-11" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in to hush</h1>
            <p className="mt-1 text-sm text-muted-foreground">Use the ADMIN_TOKEN this server was started with.</p>
          </div>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) signIn(value)
          }}
        >
          <Label htmlFor="token" className="sr-only">
            Admin token
          </Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="token"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              placeholder="Admin token"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-10 pl-9"
              aria-invalid={!!message || undefined}
              aria-describedby={message ? 'login-error' : undefined}
            />
          </div>
          {message && (
            <p id="login-error" role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
          <Button type="submit" className="h-10">
            Open dashboard
          </Button>
        </form>
        <p className="mt-5 text-center text-xs text-muted-foreground">Kept for this tab only, never in a cookie.</p>
        <BorderBeam size={120} duration={9} colorFrom="var(--brand)" colorTo="var(--chart-2)" />
      </div>
    </div>
  )
}
