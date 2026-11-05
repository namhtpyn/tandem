// stdio MCP stub: writes its pid to argv[2] and stays alive ignoring stdin —
// pins the probe kill law (the probe must not leave it running)
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 10_000);
