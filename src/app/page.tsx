export const dynamic = "force-dynamic";

export default function Home() {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  return (
    <>
      <h1>Google Ads MCP</h1>
      <p>Private connector that lets Claude read and manage Google Ads accounts.</p>
      <p>
        Connector URL for Claude: <code>{base ? `${base}/mcp` : "https://<this-domain>/mcp"}</code>
      </p>
      <p>
        In Claude: Settings → Connectors → Add custom connector → paste the URL → <b>Connect</b> → choose your Google account.
      </p>
    </>
  );
}
