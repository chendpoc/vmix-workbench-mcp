#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createWorkbench } from './server.js';

try {
  const app = await createWorkbench(readConfig());
  const transport = new StdioServerTransport();
  await app.server.connect(transport);
  const sdkClose = transport.onclose;
  transport.onclose = () => {
    sdkClose?.();
    void app.close().then(() => process.exit(0));
  };
  app.start();
  const shutdown = async () => {
    await app.close();
    await app.server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cannot start vMix MCP');
  process.exitCode = 1;
}
