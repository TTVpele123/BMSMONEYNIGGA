import "./globals.css";

export const metadata = { title: "Deal OS", description: "Live autonomous deal engine" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
