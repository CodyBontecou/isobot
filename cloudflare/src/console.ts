/** The console bundles React locally; credentials are managed only in browser memory. */
export function consoleResponse(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#fbfaf7" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#171a17" media="(prefers-color-scheme: dark)">
  <title>Pi — your durable workspace</title>
  <link rel="stylesheet" href="/console-assets/app.css">
  <script type="module" src="/console-assets/app.js"></script>
</head>
<body>
  <div id="root"><p role="status">Loading your Pi workspace…</p></div>
  <noscript>This workspace needs JavaScript to connect to Pi. Enable JavaScript and reload this page.</noscript>
</body>
</html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}
