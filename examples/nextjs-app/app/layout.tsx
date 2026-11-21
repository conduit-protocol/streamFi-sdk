import type { ReactNode } from 'react';

export const metadata = {
  title: 'StreamFi — Next.js Example',
  description: 'Example Next.js app using @conduit-protocol/sdk',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
