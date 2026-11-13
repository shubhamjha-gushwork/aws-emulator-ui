import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import localFont from 'next/font/local';
import { AppShell } from '@/components/AppShell';
import './globals.css';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const grotesk = localFont({ src: '../../public/fonts/VertGroteskDisplayVF.ttf', variable: '--font-grotesk', weight: '100 900', display: 'swap' });

export const metadata: Metadata = {
  title: 'AWS Emulator · Gushwork',
  description: 'Local dashboard for Amazon AWS Emulator',
  icons: { icon: 'https://cdn.prod.website-files.com/65c292289fb0ea1ff3a84bd3/6807f0d918342111b78873bd_gushwork-fav-con-32X32px.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable}`}>
      <body className="font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
