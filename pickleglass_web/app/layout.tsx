import './globals.css'
import { Inter } from 'next/font/google'
import ClientLayout from '@/components/ClientLayout'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'pickleglass - AI Assistant',
  description: 'Personalized AI Assistant for various contexts',
}

/**
 * Applies the theme before the first paint.
 *
 * This is a static export, so the served HTML carries no class and React only runs after the
 * document is parsed. Setting the class from a component would paint a white page first and swap
 * to dark a frame later - the exact flash that makes dark mode unpleasant to open at night.
 *
 * Kept as a string rather than imported from utils/theme.ts because it has to run inline, before
 * any bundle loads. Both must agree on the storage key and the fallback.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('glass.theme');
    var dark = stored === 'dark'
      || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    }
  } catch (e) {
    /* no stored preference and no matchMedia: light, which is the pre-existing behaviour */
  }
})();
`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    // suppressHydrationWarning: the script above edits <html> before React hydrates, so the
    // server-rendered markup and the live DOM differ here by design.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={inter.className}>
        <ClientLayout>
          {children}
        </ClientLayout>
      </body>
    </html>
  )
}
