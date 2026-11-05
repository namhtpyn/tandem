// stdio MCP stub: crashes with a stderr line before any handshake (probe law:
// first stderr line is the verdict detail)
console.error('boom: bad config file at /etc/stub.conf');
process.exit(2);
