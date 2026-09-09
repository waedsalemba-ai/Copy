import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  // Optional comma-separated list of additional RPC endpoints (e.g. Helius + a public
  // cluster) that rpcService can race/fail over across. The primary rpcUrl above is
  // always included as the first candidate.
  rpcFallbackUrls: (process.env.RPC_FALLBACK_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  laserstreamApiKey: process.env.LASERSTREAM_API_KEY || '',
  laserstreamEndpoint: process.env.LASERSTREAM_ENDPOINT || 'wss://laserstream.solana.com/v1/stream',
  // Jupiter Developer Platform API key (https://portal.jup.ag) — keys start with "jup".
  // Optional: without one, Jupiter calls run keyless at a very low, easily-exhausted
  // rate limit against a base URL that is being phased out.
  jupiterApiKey: process.env.JUPITER_API_KEY || '',
  databaseUrl: process.env.DATABASE_URL || 'file:./data/store.json',
  solPriceUsd: 145.50, // Benchmark SOL price for USD estimates
};
