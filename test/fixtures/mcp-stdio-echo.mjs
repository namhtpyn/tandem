// stdio MCP stub: echoes its env var into a stderr line, then exits 1 — pins
// the redact-before-persist law (the credential must never reach the verdict)
console.error(`stub started with MCP_ECHO_SECRET=${process.env.MCP_ECHO_SECRET ?? 'none'}`);
process.exit(2);
