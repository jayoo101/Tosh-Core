import { Suspense } from 'react'
import { RegisterPanel } from '@/components/v2/RegisterPanel'

export default function RegisterPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 font-sans text-text-primary sm:px-6">
      <Suspense>
        <RegisterPanel />
      </Suspense>
    </main>
  )
}
