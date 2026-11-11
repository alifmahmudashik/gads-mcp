export const metadata = { title: "Google Ads MCP", robots: "noindex" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ font: "16px/1.6 system-ui, sans-serif", maxWidth: 560, margin: "10vh auto", padding: "0 20px", color: "#1a1a1a" }}>{children}</body>
    </html>
  );
}
