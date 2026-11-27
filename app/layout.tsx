import type { Metadata } from "next";
import { headers } from "next/headers";
import { Newsreader, Public_Sans } from "next/font/google";
import "./globals.css";

const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Page-first editor",
  description:
    "Edit a page, commit it to a Google Doc, and publish a static snapshot.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading request headers renders every page per request, so each response
  // carries the CSP nonce that middleware generated for it.
  await headers();
  return (
    <html lang="en" className={`${publicSans.variable} ${newsreader.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
