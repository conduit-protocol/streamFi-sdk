"use client";

import type { ReactNode } from "react";
import { StreamFiProvider } from "@streamfi/react";
import { getNetwork, getKeypair, getFactoryAddress } from "../lib/conduit";

export default function RootLayout({ children }: { children: ReactNode }) {
  const network = getNetwork();
  const keypair = getKeypair();
  const factoryAddress = getFactoryAddress();

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <StreamFiProvider
          network={network}
          keypair={keypair}
          factoryAddress={factoryAddress}
        >
          {children}
        </StreamFiProvider>
      </body>
    </html>
  );
}
