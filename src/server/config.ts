import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Live Stream Configuration
  liveApiKey: process.env.LIVE_API_KEY || '',
  primaryRpcUrl: process.env.PRIMARY_RPC_URL || process.env.RPC_URL || 'https://solana-rpc.publicnode.com',
  secondaryRpcUrl: process.env.SECONDARY_RPC_URL || 'https://api.mainnet-beta.solana.com',
  primaryLaserstreamEndpoint: process.env.PRIMARY_LASERSTREAM_ENDPOINT || process.env.LASERSTREAM_ENDPOINT || 'wss://laserstream.solana.com/v1/stream',
  primaryLaserstreamApiKey: process.env.PRIMARY_LASERSTREAM_API_KEY || process.env.LASERSTREAM_API_KEY || '',
  secondaryLaserstreamEndpoint: process.env.SECONDARY_LASERSTREAM_ENDPOINT || 'wss://laserstream.solana.com/v1/stream',
  secondaryLaserstreamApiKey: process.env.SECONDARY_LASERSTREAM_API_KEY || '',
  solanaWssUrl: process.env.SOLANA_WSS_URL || 'wss://api.mainnet-beta.solana.com',

  // Paper Trading Configuration (strictly isolated)
  paperApiKey: process.env.PAPER_API_KEY || '',
  jupiterApiKey: process.env.JUPITER_API_KEY || '',

  // Backward compatibility aliases
  rpcUrl: process.env.RPC_URL || 'https://solana-rpc.publicnode.com',
  rpcFallbackUrls: (process.env.RPC_FALLBACK_URLS || 'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  laserstreamApiKey: process.env.LASERSTREAM_API_KEY || '',
  laserstreamEndpoint: process.env.LASERSTREAM_ENDPOINT || 'wss://laserstream.solana.com/v1/stream',

  databaseUrl: process.env.DATABASE_URL || 'file:./data/store.json',
  solPriceUsd: 145.50, // Benchmark SOL price for USD estimates
};
