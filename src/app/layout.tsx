import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "OpenDiligence",
  description: "Prototype AI-driven due diligence reports on people and companies.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
