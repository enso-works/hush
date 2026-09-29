import { TriangleAlert } from 'lucide-react'

export function ErrorNote({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      Could not load this page: {message}
    </div>
  )
}
