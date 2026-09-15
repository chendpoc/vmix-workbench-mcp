// Real stdio MCP transport against a loopback-only vMix simulator.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-vmix.mjs';
const mock = await startMock(),
  dir = await mkdtemp(path.join(os.tmpdir(), 'vmix-stdio-'));
const client = new Client({ name: 'stdio-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../build/index.js', import.meta.url))],
  env: { ...process.env, VMIX_API_URL: mock.url, VMIX_DATA_DIR: dir, VMIX_READ_ONLY: 'false' },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (b) => (stderr += b.toString()));
try {
  await client.connect(transport);
  const list = await client.listTools();
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const scene = await call('vmix_scene_template', {
    request_id: 'stdio-scene',
    name: 'Badminton quad',
    layout: 'quad',
    sources: ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'],
  });
  assert.equal(scene.status, 'completed');
  await call('vmix_transition_configure', {
    request_id: 'stdio-transition',
    button: 1,
    effect: 'Fade',
    duration_ms: 500,
  });
  await call('vmix_actions', {
    request_id: 'stdio-take',
    actions: [{ type: 'transition', input: 'Badminton quad', effect: 'Fade', duration_ms: 100 }],
  });
  const state = await call('vmix_inspect', {});
  assert.equal(state.active, scene.result.created_input);
  console.log(
    JSON.stringify(
      {
        transport: 'stdio',
        tools: list.tools.length,
        scene: scene.status,
        programConfirmed: true,
        liveVmix: false,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await transport.close();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
  if (stderr) console.error(stderr);
}
