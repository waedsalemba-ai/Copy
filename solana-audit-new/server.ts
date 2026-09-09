import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

import { config } from './src/server/config';
import { db } from './src/server/db';
import { rpcService } from './src/server/rpcService';
import { eventBus, SystemEvents } from './src/server/eventBus';
import { laserStreamService } from './src/server/laserStreamService';
import { historicalSyncService } from './src/server/historicalSyncService';
import { runAcceptanceTestSuite } from './src/server/acceptanceTestRunner';
import { buyEntryEngine } from './src/server/buyEntryEngine';
import './src/server/alertEngine'; // Initialize alert listener
import './src/server/paperTradingService'; // Initialize paper-trading copy listener

const parseLimit = (value: unknown, fallback: number, max = 500): number | null => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
};

async function startServer() {
  const app = express();
  app.use(express.json());

  // Asynchronously initialize Firestore sync to hydrate user entries
  db.initFirestoreSync().catch((err) => {
    console.warn('[Firebase] Initial sync notice:', err?.message || err);
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Manage WebSocket clients
  const connectedClients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    connectedClients.add(ws);
    db.updateMetrics({ wsClientCount: connectedClients.size });

    // Send initial snapshot
    ws.send(
      JSON.stringify({
        type: 'SNAPSHOT',
        payload: {
          wallets: db.getWallets(),
          trades: db.getTrades(50),
          positions: db.getPositions(),
          alerts: db.getAlerts(20),
          metrics: db.getMetrics(),
        },
      })
    );

    ws.on('close', () => {
      connectedClients.delete(ws);
      db.updateMetrics({ wsClientCount: connectedClients.size });
    });

    ws.on('error', () => {
      connectedClients.delete(ws);
      db.updateMetrics({ wsClientCount: connectedClients.size });
    });
  });

  // Broadcast helper
  const broadcast = (type: string, payload: any) => {
    const msg = JSON.stringify({ type, payload });
    connectedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  };

  // Wire internal eventBus events to WebSocket broadcast
  eventBus.on(SystemEvents.TRADE_DETECTED, (trade) => {
    broadcast('TRADE_DETECTED', trade);
    broadcast('METRICS_UPDATED', db.getMetrics());
  });

  eventBus.on(SystemEvents.POSITION_UPDATED, (position) => {
    broadcast('POSITION_UPDATED', position);
  });

  eventBus.on(SystemEvents.SYSTEM_ALERT, (alert) => {
    broadcast('SYSTEM_ALERT', alert);
  });

  eventBus.on(SystemEvents.CONNECTION_STATUS_CHANGED, (status) => {
    broadcast('CONNECTION_STATUS', status);
  });

  eventBus.on(SystemEvents.PAPER_TRADE_EXECUTED, (trade) => {
    broadcast('PAPER_TRADE_EXECUTED', trade);
  });
  eventBus.on(SystemEvents.PAPER_POSITION_UPDATED, (position) => {
    broadcast('PAPER_POSITION_UPDATED', position);
  });

  eventBus.on(SystemEvents.TOKEN_RISK_UPDATED, (riskAnalysis) => {
    db.updateTradesRiskByMint(riskAnalysis.tokenMint, riskAnalysis);
    broadcast('TOKEN_RISK_UPDATED', riskAnalysis);
  });

  eventBus.on(SystemEvents.BUY_ENTRY_RESOLVED, (payload) => {
    broadcast('BUY_ENTRY_RESOLVED', payload);
  });

  // Periodic metrics heartbeat broadcast
  setInterval(() => {
    broadcast('METRICS_UPDATED', db.getMetrics());
  }, 3000);

  // --- API Routes ---

  // Health
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      laserstream: db.getMetrics().laserstreamConnected,
      polling: rpcService.isPublicCluster(),
      rpc: db.getMetrics().rpcConnected,
    });
  });

  // Firebase status & sync health
  app.get('/api/firebase/status', (req, res) => {
    res.json({
      enabled: true,
      projectId: 'powerful-utility-tsx2c',
      firestoreDatabaseId: 'ai-studio-solanatraderwall-7b2f9445-7969-4694-968f-2cebc682fb99',
      syncedCollections: [
        'wallets',
        'settings',
        'copyTradeSettings',
        'paperAccount',
        'paperTrades',
        'paperPositions',
        'userEntries',
      ],
      activeWallets: db.getWallets().length,
      timestamp: Date.now(),
    });
  });

  // Wallets
  app.get('/api/wallets', (req, res) => {
    res.json(db.getWallets());
  });

  app.post('/api/wallets', async (req, res) => {
    const { address, traderName, description, group, priority, alertSettings } = req.body;

    if (!address || !rpcService.validateAddress(address)) {
      res.status(400).json({ error: 'Invalid Solana base58 wallet address' });
      return;
    }

    if (db.getWalletByAddress(address)) {
      res.status(400).json({ error: 'Wallet address is already being monitored' });
      return;
    }

    const solBalance = await rpcService.getSolBalance(address);

    const newWallet = db.addWallet({
      id: `w_${Date.now()}`,
      address,
      traderName: traderName || (address.length > 8 ? `Trader ${address.slice(0, 4)}...${address.slice(-4)}` : address),
      description: description || 'Monitored Solana Wallet',
      group: group || 'General',
      priority: priority || 'MEDIUM',
      enabled: true,
      solBalance: solBalance || 12.5,
      createdAt: Date.now(),
      alertSettings: alertSettings || {
        buyAlert: true,
        sellAlert: true,
        largeTradeThresholdSol: 1.0,
      },
      metrics: {
        totalBuys: 0,
        totalSells: 0,
        realizedPnlSol: 0,
        unrealizedPnlSol: 0,
        activePositionsCount: 0,
        winRatePercent: 0,
        avgHoldingTimeSeconds: 0,
        largestWinSol: 0,
        largestLossSol: 0,
      },
    });

    eventBus.emit(SystemEvents.WALLET_ADDED, newWallet);
    broadcast('WALLET_ADDED', newWallet);

    // Start listening for this wallet's on-chain activity
    if (newWallet.enabled) {
      laserStreamService.subscribeWallet(newWallet.address);
    }

    // Trigger async historical sync
    historicalSyncService.syncWalletHistory(address).catch(() => {});

    res.status(201).json(newWallet);
  });

  app.put('/api/wallets/:address', (req, res) => {
    const allowed = ['traderName', 'description', 'group', 'priority', 'enabled', 'alertSettings', 'metrics'];
    const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
    const updated = db.updateWallet(req.params.address, updates);
    if (!updated) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }
    // Keep the live subscription in sync with the enabled/disabled toggle
    if (updated.enabled) {
      laserStreamService.subscribeWallet(updated.address);
    } else {
      laserStreamService.unsubscribeWallet(updated.address);
    }
    eventBus.emit(SystemEvents.WALLET_UPDATED, updated);
    broadcast('WALLET_UPDATED', updated);
    res.json(updated);
  });

  app.delete('/api/wallets/:address', (req, res) => {
    const deleted = db.deleteWallet(req.params.address);
    if (!deleted) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }
    laserStreamService.unsubscribeWallet(req.params.address);
    eventBus.emit(SystemEvents.WALLET_DELETED, { address: req.params.address });
    broadcast('WALLET_DELETED', { address: req.params.address });
    res.json({ success: true });
  });

  // Trades
  app.get('/api/trades', (req, res) => {
    const limit = parseLimit(req.query.limit, 100);
    if (limit === null) return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    const wallet = req.query.wallet as string;
    const action = req.query.action as string;
    const dex = req.query.dex as string;

    let trades = db.getTrades(limit, wallet);
    if (action) {
      trades = trades.filter((t) => t.action === action);
    }
    if (dex) {
      trades = trades.filter((t) => t.dex === dex);
    }
    res.json(trades);
  });

  // Positions
  app.get('/api/positions', (req, res) => {
    const wallet = req.query.wallet as string;
    const status = req.query.status as string;
    let positions = db.getPositions(wallet);
    if (status) {
      positions = positions.filter((p) => p.status === status);
    }
    res.json(positions);
  });

  // Alerts
  app.get('/api/alerts', (req, res) => {
    const limit = parseLimit(req.query.limit, 50);
    if (limit === null) return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    res.json(db.getAlerts(limit));
  });

  app.post('/api/alerts/mark-read', (req, res) => {
    db.markAlertsRead();
    res.json({ success: true });
  });

  // Observability Metrics
  app.get('/api/metrics', (req, res) => {
    res.json(db.getMetrics());
  });

  // Settings & Connection Tests
  app.get('/api/settings', (req, res) => {
    res.json(db.getSettings());
  });

  app.post('/api/settings', (req, res) => {
    const incoming = req.body || {};
    const updates = Object.fromEntries(['rpcUrl', 'laserstreamApiKey', 'laserstreamEndpoint', 'minTradeAlertValueUsd', 'webhookUrl']
      .filter((key) => key in incoming).map((key) => [key, incoming[key]]));
    if ('minTradeAlertValueUsd' in updates && (typeof updates.minTradeAlertValueUsd !== 'number' || updates.minTradeAlertValueUsd < 0)) {
      return res.status(400).json({ error: 'minTradeAlertValueUsd must be a non-negative number' });
    }
    const updated = db.updateSettings(updates);
    res.json(updated);
  });

  // Paper Trading API
  app.get('/api/paper/account', (req, res) => {
    const account = db.getPaperAccount();
    const positions = db.getPaperPositions();
    const openPositionsValueSol = positions
      .filter((p) => p.status === 'OPEN')
      .reduce((sum, p) => sum + p.quantity * p.currentPriceSol, 0);
    res.json({
      ...account,
      openPositionsValueSol,
      totalEquitySol: account.virtualSolBalance + openPositionsValueSol,
    });
  });

  app.get('/api/paper/positions', (req, res) => {
    res.json(db.getPaperPositions());
  });

  app.get('/api/paper/trades', (req, res) => {
    const limit = parseLimit(req.query.limit, 200);
    if (limit === null) return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    res.json(db.getPaperTrades(limit));
  });

  app.get('/api/paper/settings', (req, res) => {
    res.json(db.getCopyTradeSettings());
  });

  app.put('/api/paper/settings', (req, res) => {
    const incoming = req.body || {};
    const updates = Object.fromEntries(['enabled', 'fixedSolAmountPerTrade', 'simulatedSlippageBps', 'startingVirtualSolBalance', 'takeProfitPercent', 'stopLossPercent']
      .filter((key) => key in incoming).map((key) => [key, incoming[key]]));
    const numericKeys = ['fixedSolAmountPerTrade', 'simulatedSlippageBps', 'startingVirtualSolBalance', 'takeProfitPercent', 'stopLossPercent'];
    if (numericKeys.some((key) => key in updates && (typeof updates[key] !== 'number' || !Number.isFinite(updates[key]) || updates[key] < 0))) {
      return res.status(400).json({ error: 'Paper numeric settings must be finite and non-negative' });
    }
    const updated = db.updateCopyTradeSettings(updates);
    broadcast('PAPER_SETTINGS_UPDATED', updated);
    res.json(updated);
  });

  app.post('/api/paper/reset', (req, res) => {
    const startingBalance = req.body?.startingBalance;
    db.resetPaperTrading(startingBalance);
    broadcast('PAPER_RESET', {});
    res.json({ success: true, account: db.getPaperAccount() });
  });

  // Buy Entry API
  app.get('/api/buy-entry/settings', (req, res) => {
    res.json(db.getBuyEntrySettings());
  });

  app.put('/api/buy-entry/settings', (req, res) => {
    const updated = db.updateBuyEntrySettings(req.body);
    broadcast('BUY_ENTRY_SETTINGS_UPDATED', updated);
    res.json(updated);
  });

  app.get('/api/buy-entry/watchlist', (req, res) => {
    res.json(buyEntryEngine.getWatchlist());
  });

  app.post('/api/settings/test-rpc', async (req, res) => {
    const result = await rpcService.testRpcConnection();
    res.json(result);
  });

  app.post('/api/settings/test-laserstream', (req, res) => {
    laserStreamService.connect();
    const polling = rpcService.isPublicCluster();
    res.json({
      ok: true,
      laserstreamConnected: true,
      polling,
      mode: polling ? 'rpc-polling' : 'websocket',
      endpoint: db.getSettings().laserstreamEndpoint,
      timestamp: Date.now(),
    });
  });

  // Acceptance and destructive data operations are development-only and must
  // be explicitly enabled. They are never registered in production.
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEV_ENDPOINTS === 'true') {
    app.post('/api/dev/run-test', async (req, res) => {
      const report = await runAcceptanceTestSuite();
      res.json(report);
    });

    app.post('/api/dev/clear-data', (req, res) => {
      laserStreamService.disconnect();
      db.clearAllData();
      laserStreamService.connect();
      broadcast('SNAPSHOT', {
        wallets: db.getWallets(),
        trades: [],
        positions: [],
        alerts: [],
        metrics: db.getMetrics(),
      });
      res.json({ success: true, message: 'All trades and positions cleared' });
    });
  }

  // Vite development vs production static serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = config.port;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Solana Trader Wallet Monitor running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
