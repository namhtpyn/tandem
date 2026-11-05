// stdio MCP stub for unit tests (slice 3): answers the initialize handshake
// with serverInfo.name = env report, serverInfo.version = args report.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.once('line', () => {
  const name = 'PATH' in process.env ? `env-leak` : process.env.MCP_API_KEY ? 'env-ok' : 'env-none';
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name, version: process.argv.slice(2).join(',') } },
    })}\n`,
  );
  process.exit(0);
});
