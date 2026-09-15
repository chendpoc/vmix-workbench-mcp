import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkbench } from '../build/server.js';
import { readConfig } from '../build/config.js';
import { VmixClient, parseState } from '../build/vmix.js';
import { edge } from '../build/triggers.js';
import { startMock } from '../scripts/mock-vmix.mjs';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vmix-mcp-test-'));
  const mock = await startMock();
  const config = readConfig({
    VMIX_API_URL: mock.url,
    VMIX_DATA_DIR: dir,
    VMIX_SOURCE_ROOTS: JSON.stringify([dir]),
    VMIX_TIMEOUT_MS: '300',
  });
  const app = await createWorkbench(config);
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await app.server.connect(st);
  await client.connect(ct);
  t.after(async () => {
    await client.close();
    await app.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(r.content[0].text);
    } catch {
      data = { error: { message: r.content[0].text } };
    }
    return { error: r.isError ?? false, data };
  };
  return { dir, mock, config, app, client, call };
}

test('MCP discovery, asset stage/import, scene, title, native transition, named preset', async (t) => {
  const { call, mock, dir, client } = await setup(t);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 16);
  const state = await call('vmix_inspect');
  assert.equal(state.data.inputs.length, 6);
  await writeFile(path.join(dir, '球员.png'), Buffer.from('mock media bytes'));
  const staged = await call('vmix_asset_stage', { source_path: path.join(dir, '球员.png') });
  assert.equal(staged.error, false);
  assert.equal((await readFile(staged.data.vmix_path)).toString(), 'mock media bytes');
  const imported = await call('vmix_input_add', {
    request_id: 'add-picture',
    type: 'Image',
    value: staged.data.vmix_path,
    name: 'Player image',
  });
  assert.equal(imported.data.status, 'completed');
  assert.ok(imported.data.result.created_input);
  const args = {
    request_id: 'build-split',
    name: 'Court split',
    layout: 'two_up',
    sources: ['Camera 1', 'Camera 2'],
    width: 3840,
    height: 2160,
  };
  const dry = await call('vmix_scene_template', { ...args, dry_run: true });
  assert.equal(dry.error, false);
  assert.equal(mock.model.inputs.length, 7);
  const built = await call('vmix_scene_template', args);
  assert.equal(built.data.status, 'completed');
  assert.equal(mock.model.inputs.at(-1).layers.length, 2);
  assert.equal(mock.model.active, mock.model.inputs[0].key);
  const changed = await call('vmix_actions', {
    request_id: 'score',
    actions: [{ type: 'text', input: 'Scoreboard', field: 'Score.Text', value: '21 : 19 & 胜利' }],
  });
  assert.equal(changed.data.status, 'completed');
  assert.equal(mock.model.inputs[4].texts[0].value, '21 : 19 & 胜利');
  const native = await call('vmix_transition_configure', {
    request_id: 'native',
    button: 1,
    effect: 'Fade',
    duration_ms: 750,
    gt_input: 'Scoreboard',
    stinger_slot: 1,
  });
  assert.equal(native.data.status, 'completed');
  assert.equal(mock.model.transitionButtons.SetTransitionDuration1, '750');
  await call('vmix_transition_preset_save', { name: 'gentle', effect: 'Fade', duration_ms: 250 });
  const take = await call('vmix_transition', {
    request_id: 'take',
    input: 'Court split',
    preset: 'gentle',
  });
  assert.equal(take.data.status, 'completed');
  assert.equal(mock.model.active, built.data.result.created_input);
});

test('duplicate request has one effect and conflicting payload is rejected', async (t) => {
  const { call, mock } = await setup(t);
  const args = { request_id: 'same', type: 'Colour', value: '#000000', name: 'New' };
  const a = await call('vmix_input_add', args),
    b = await call('vmix_input_add', args);
  assert.equal(a.data.result.created_input, b.data.result.created_input);
  assert.equal(mock.model.commands.filter((c) => c.Function === 'AddInput').length, 1);
  const conflict = await call('vmix_input_add', { ...args, name: 'Different' });
  assert.equal(conflict.data.error.code, 'REQUEST_CONFLICT');
});

test('all actions validate before writes; replay range and layer cycles are rejected', async (t) => {
  const { call, mock } = await setup(t);
  const bad = await call('vmix_actions', {
    request_id: 'bad',
    actions: [
      { type: 'preview', input: 'Camera 1' },
      { type: 'text', input: 'Scoreboard', field: 'No.Text', value: 'x' },
    ],
  });
  assert.equal(bad.error, true);
  assert.equal(mock.model.commands.length, 0);
  const speed = await call('vmix_actions', {
    request_id: 'speed',
    actions: [{ type: 'replay', command: 'speed', speed: 2 }],
  });
  assert.equal(speed.error, true);
  const cycle = await call('vmix_actions', {
    request_id: 'cycle',
    actions: [
      { type: 'layer', input: 'Camera 1', source: 'Camera 2', index: 1 },
      { type: 'layer', input: 'Camera 2', source: 'Camera 1', index: 1 },
    ],
  });
  assert.equal(cycle.error, true);
  assert.equal(mock.model.commands.length, 0);
});

test('partial scene failure preserves created identity and stops subsequent commands', async (t) => {
  const { call, mock } = await setup(t);
  mock.model.failFunction = 'SetLayer1Rectangle';
  const result = await call('vmix_scene_template', {
    request_id: 'partial',
    name: 'Half scene',
    layout: 'two_up',
    sources: ['Camera 1', 'Camera 2'],
  });
  assert.equal(result.error, true);
  assert.equal(result.data.status, 'unconfirmed');
  assert.ok(mock.model.inputs.find((i) => i.title === 'Half scene'));
  assert.equal(mock.model.commands.filter((c) => c.Function === 'SetLayer').length, 1);
  const duplicate = await call('vmix_scene_template', {
    request_id: 'partial',
    name: 'Half scene',
    layout: 'two_up',
    sources: ['Camera 1', 'Camera 2'],
  });
  assert.equal(duplicate.data.status, 'unconfirmed');
  assert.equal(mock.model.commands.filter((c) => c.Function === 'AddInput').length, 1);
});

test('whole HTTP response has deadline, HTML/DTD/duplicate identities rejected', async (t) => {
  const { config, mock } = await setup(t);
  mock.model.delayBodyMs = 500;
  const client = new VmixClient({ ...config, timeoutMs: 100 });
  await assert.rejects(client.state(), (e) => e.code === 'TIMEOUT');
  assert.throws(
    () => parseState('<html>ok</html>'),
    (e) => e.code === 'INVALID_STATE',
  );
  assert.throws(
    () => parseState('<!DOCTYPE vmix><vmix/>'),
    (e) => e.code === 'INVALID_STATE',
  );
  mock.model.inputs[1].key = mock.model.inputs[0].key;
  assert.throws(
    () => parseState(mock.xml()),
    (e) => e.code === 'INVALID_STATE',
  );
});

test('source symlink escape is rejected and dry-run creates no asset', async (t) => {
  const { dir, call } = await setup(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vmix-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'x.png'), 'outside');
  try {
    await symlink(path.join(outside, 'x.png'), path.join(dir, 'link.png'));
  } catch (e) {
    if (e.code === 'EPERM') {
      t.skip('OS does not allow symlinks');
      return;
    }
    throw e;
  }
  const result = await call('vmix_asset_stage', { source_path: path.join(dir, 'link.png') });
  assert.equal(result.data.error.code, 'ASSET_ROOT');
  await writeFile(path.join(dir, 'ok.png'), 'inside');
  const dry = await call('vmix_asset_stage', {
    source_path: path.join(dir, 'ok.png'),
    dry_run: true,
  });
  await assert.rejects(readFile(dry.data.vmix_path), (e) => e.code === 'ENOENT');
});

test('managed trigger is disarmed by default, fires once and does not re-run on startup/reconnect', async (t) => {
  const { call, app, mock } = await setup(t);
  await call('vmix_trigger_save', {
    trigger: {
      id: 'score-in',
      input: 'Camera 2',
      event: 'program_enter',
      actions: [{ type: 'overlay', channel: 1, visible: true, input: 'Scoreboard' }],
    },
  });
  mock.model.active = mock.model.inputs[1].key;
  await app.triggers.tick();
  assert.equal(mock.model.commands.length, 0);
  await call('vmix_trigger_arm', { id: 'score-in', armed: true });
  await app.triggers.tick();
  assert.equal(mock.model.commands.length, 0);
  mock.model.active = mock.model.inputs[0].key;
  await app.triggers.tick();
  mock.model.invalidXml = true;
  await app.triggers.tick();
  mock.model.active = mock.model.inputs[1].key;
  mock.model.invalidXml = false;
  await app.triggers.tick();
  assert.equal(mock.model.commands.length, 0);
  mock.model.active = mock.model.inputs[0].key;
  await app.triggers.tick();
  mock.model.active = mock.model.inputs[1].key;
  await app.triggers.tick();
  assert.equal(mock.model.overlays[1], mock.model.inputs[4].key);
  assert.equal((await call('vmix_configuration')).data.triggers[0].armed, false);
});

test('disarm cancels delayed trigger actions', async (t) => {
  const { call, app, mock } = await setup(t);
  await call('vmix_trigger_save', {
    trigger: {
      id: 'delayed',
      input: 'Camera 2',
      event: 'program_enter',
      actions: [
        { type: 'wait', ms: 300 },
        { type: 'overlay', channel: 1, visible: true, input: 'Scoreboard' },
      ],
    },
  });
  await call('vmix_trigger_arm', { id: 'delayed', armed: true });
  mock.model.active = mock.model.inputs[1].key;
  const tick = app.triggers.tick();
  await new Promise((r) => setTimeout(r, 50));
  await call('vmix_trigger_arm', { id: 'delayed', armed: false });
  await tick;
  assert.equal(mock.model.commands.length, 0);
});

test('state survives restart; in-flight operations become unconfirmed; triggers remain disarmed', async (t) => {
  const { app, call, config } = await setup(t);
  await call('vmix_input_add', { request_id: 'persist', type: 'Colour', value: '#000000' });
  app.engine.store.data.operations.interrupted = {
    id: 'interrupted',
    fingerprint: 'abc',
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: [],
  };
  await app.engine.store.save();
  await app.close();
  const restarted = await createWorkbench(config);
  try {
    assert.equal(restarted.engine.store.data.operations.persist.status, 'completed');
    assert.equal(restarted.engine.store.data.operations.interrupted.status, 'unconfirmed');
  } finally {
    await restarted.close();
  }
});

test('explicit read-only configuration parses false correctly and prohibits writes', async (t) => {
  const { config, app, call } = await setup(t);
  assert.equal(config.readOnly, false);
  config.readOnly = true;
  const result = await call('vmix_actions', {
    request_id: 'no-write',
    actions: [{ type: 'preview', input: 'Camera 2' }],
  });
  assert.equal(result.data.error.code, 'READ_ONLY');
  const dry = await call('vmix_actions', {
    request_id: 'dry',
    dry_run: true,
    actions: [{ type: 'preview', input: 'Camera 2' }],
  });
  assert.equal(dry.error, false);
  assert.equal(app.engine.store.data.operations['no-write'], undefined);
});

test('playback_stopped means observed pause, not proof of natural completion', () => {
  const before = { inputs: [{ key: 'x', state: 'Running', position: 100 }], overlays: [] },
    after = { inputs: [{ key: 'x', state: 'Paused', position: 100 }], overlays: [] };
  assert.equal(edge({ input: 'x', event: 'playback_stopped' }, before, after), true);
});

test('API acceptance without state change is unconfirmed and never automatically retried', async (t) => {
  const { call, mock } = await setup(t);
  mock.model.ignoreFunction = 'Cut';
  const result = await call('vmix_actions', {
    request_id: 'lost-effect',
    actions: [{ type: 'transition', input: 'Camera 2', effect: 'Cut' }],
  });
  assert.equal(result.data.status, 'unconfirmed');
  assert.equal(result.data.error.code, 'NOT_CONFIRMED');
  assert.equal(mock.model.commands.filter((c) => c.Function === 'Cut').length, 1);
});

test('Windows share mapping yields a Windows path while copying bytes locally', async (t) => {
  const { call, config, dir } = await setup(t);
  config.vmixAssetRoot = 'C:\\vMixAssets';
  await writeFile(path.join(dir, 'mapped.png'), 'mapped bytes');
  const result = await call('vmix_asset_stage', { source_path: path.join(dir, 'mapped.png') });
  assert.match(result.data.vmix_path, /^C:\\vMixAssets\\[a-f0-9]{64}\.png$/);
  assert.equal(
    (
      await readFile(path.join(config.assetRoot, path.win32.basename(result.data.vmix_path)))
    ).toString(),
    'mapped bytes',
  );
});

test('a second process cannot share the state directory', async (t) => {
  const { config } = await setup(t);
  await assert.rejects(createWorkbench(config), (e) => e.code === 'STATE_LOCKED');
});

test('invalid trigger actions disable the rule instead of retriggering repeatedly', async (t) => {
  const { call, app, mock } = await setup(t);
  await call('vmix_trigger_save', {
    trigger: {
      id: 'missing-title',
      input: 'Camera 2',
      event: 'program_enter',
      actions: [{ type: 'text', input: 'Scoreboard', field: 'Score.Text', value: '1 : 0' }],
    },
  });
  await call('vmix_trigger_arm', { id: 'missing-title', armed: true });
  mock.model.inputs[4].texts = [];
  mock.model.active = mock.model.inputs[1].key;
  await app.triggers.tick();
  const config = await call('vmix_configuration');
  assert.equal(config.data.triggers[0].armed, false);
  assert.ok(config.data.trigger_error);
});

test('reserved IDs fail before creating state or sending commands', async (t) => {
  const { call, mock } = await setup(t);
  const result = await call('vmix_input_add', {
    request_id: '__proto__',
    type: 'Colour',
    value: '#000000',
  });
  assert.equal(result.error, true);
  assert.equal(mock.model.commands.length, 0);
});

test('GT image fields are discoverable, validated and read back after replacement', async (t) => {
  const { call } = await setup(t);
  const state = await call('vmix_inspect');
  assert.equal(state.data.inputs[4].images[0].name, 'Photo.Source');
  const result = await call('vmix_actions', {
    request_id: 'photo',
    actions: [
      { type: 'image', input: 'Scoreboard', field: 'Photo.Source', path: 'C:\\Media\\人物.png' },
    ],
  });
  assert.equal(result.data.status, 'completed');
  assert.equal(result.data.steps[0].verification, 'state_observed');
});

test('lock from a verified dead local owner is recovered without replaying commands', async (t) => {
  const { app, config, mock } = await setup(t);
  await app.close();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(dead.pid > 0);
  await writeFile(
    path.join(config.dataDir, 'process.lock'),
    JSON.stringify({ pid: dead.pid, host: os.hostname(), token: 'old' }),
  );
  const reopened = await createWorkbench(config);
  try {
    assert.equal(mock.model.commands.length, 0);
  } finally {
    await reopened.close();
  }
});
