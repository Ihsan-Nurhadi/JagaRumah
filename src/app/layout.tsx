import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "sweetalert2/dist/sweetalert2.min.css";
import "./globals.css";

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Nayaka Admin",
    template: "%s | Nayaka Admin",
  },
  description:
    "Konsol admin untuk mengelola customer, perangkat CCTV, subscription, dan pembayaran.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      suppressHydrationWarning
      className={`${publicSans.variable} h-full antialiased`}
    >
      <body className="bg-background text-foreground min-h-full">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
