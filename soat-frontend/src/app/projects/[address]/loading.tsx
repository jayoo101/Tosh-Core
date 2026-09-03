import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div className="text-text-primary font-sans">
      <main className="max-w-3xl mx-auto py-6 px-4 md:px-6">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-80" radius="card" />
      </main>
    </div>
  )
}
