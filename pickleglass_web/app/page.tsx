'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    // Activity, not Personalize: the reason to open the web GUI is to look at past sessions,
    // whereas Personalize is configuration you touch once. `replace` rather than `push` so this
    // redirect leaves no history entry - with `push`, Back from the landing page returns here and
    // is immediately redirected forward again, which reads as a broken Back button.
    router.replace('/activity')
  }, [router])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading...</p>
      </div>
    </div>
  )
} 