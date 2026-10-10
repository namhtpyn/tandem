// does buildServerContext receive my forced-null getSession? The handler
// spreads context through middleware — maybe it re-imports './auth' via
// buildServerContext lazy getter — no, we REPLACED the getter. Unless the
// '~orpc'.handler IGNORES context.getSession and uses the GLOBAL auth?? Test:
