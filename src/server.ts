import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  actionSchema,
  compile,
  effect,
  duration,
  rect,
  crop,
  ref,
  requestFields,
  safeName,
  type Action,
  type Command,
} from './actions.js';
import { VmixClient, Fault, resolveInput, type State } from './vmix.js';
import { Engine } from './engine.js';
import { Store } from './store.js';
import { Assets, validateMediaPath } from './assets.js';
import { Triggers, triggerSchema } from './triggers.js';
import type { Config } from './config.js';

const layer = z
  .object({
    source: ref,
    index: z.number().int().min(1).max(10),
    rectangle: rect.optional(),
    crop: crop.optional(),
  })
  .strict();
const sceneFields = {
  ...requestFields,
  name: z.string().min(1).max(120),
  background: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default('#000000'),
  layers: z.array(layer).min(1).max(10),
};
function scenePlan(s: State, a: z.infer<z.ZodObject<typeof sceneFields>>): Command[] {
  if (s.inputs.some((i) => i.title === a.name))
    throw new Fault('SCENE_EXISTS', 'Choose a unique scene name or update its existing layers');
  if (new Set(a.layers.map((l) => l.index)).size !== a.layers.length)
    throw new Fault('LAYER_INDEX', 'Layer indices must be unique');
  const sources = a.layers.map((l) => ({ ...l, source: resolveInput(s, l.source).key }));
  s.inputs.push({
    key: '$created',
    number: Math.max(0, ...s.inputs.map((i) => i.number)) + 1,
    title: a.name,
    type: 'Colour',
    state: 'Paused',
    position: 0,
    duration: 0,
    loop: false,
    texts: [],
    images: [],
    layers: [],
  });
  return [
    { function: 'AddInput', params: { Value: `Colour|${a.background}` }, discoversInput: true },
    { function: 'SetInputName', params: { Input: '$created', Value: a.name } },
    ...compile(
      sources.map((l) => ({ type: 'layer', input: '$created', ...l })),
      s,
    ),
  ];
}

export async function createWorkbench(config: Config) {
  const store = new Store(config.dataDir);
  await store.init();
  const engine = new Engine(new VmixClient(config), store, config),
    assets = new Assets(config),
    triggers = new Triggers(engine);
  const server = new McpServer(
    { name: 'vmix-workbench', version: '0.1.0' },
    {
      instructions:
        'Inspect inputs first. Use GUIDs or unique exact names. Dry-run complex builds first, then reuse request_id for retries. Never claim API acceptance proves visual correctness. MCP triggers need this process alive and are not native vMix trigger entries. Asset paths are on the vMix host; use staging/path mapping for transfer.',
    },
  );
  const tool = (
    name: string,
    description: string,
    schema: z.AnyZodObject,
    readOnly: boolean,
    fn: (args: any) => Promise<any>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema.shape,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
      },
      async (raw: unknown) => {
        try {
          const result = await fn(schema.parse(raw));
          const failed = ['failed', 'partial', 'unconfirmed'].includes(result?.status);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            isError: failed,
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: {
                    code:
                      error instanceof Fault
                        ? error.code
                        : error instanceof z.ZodError
                          ? 'VALIDATION'
                          : 'INTERNAL',
                    message: error instanceof Error ? error.message : 'Unknown failure',
                  },
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  };
  tool(
    'vmix_inspect',
    'Read real vMix inputs, GUIDs, title fields, layers, program, preview and overlays.',
    z.object({}),
    true,
    async () => ({
      ...(await engine.client.state()),
      read_only: config.readOnly,
      managed_trigger_error: triggers.lastError,
    }),
  );
  tool(
    'vmix_operation_get',
    'Get persisted operation status. Same request_id is never executed twice, including after restart.',
    z.object({ request_id: requestFields.request_id }),
    true,
    async (a) => {
      const op = store.data.operations[a.request_id];
      if (!op) throw new Fault('OPERATION_MISSING', 'Unknown request_id');
      return op;
    },
  );
  tool(
    'vmix_actions',
    'Run up to 20 typed actions in order. Supports preview, transition, overlay, text/image, playback/audio, layers, native transition buttons, GT stinger binding and replay. No arbitrary API function.',
    z.object({ ...requestFields, actions: z.array(actionSchema).min(1).max(20) }).strict(),
    false,
    (a) => engine.actions(a.request_id, a.actions, a.dry_run),
  );
  tool(
    'vmix_title_update',
    'Update named text fields on a title input. Inspect exact field names first (GT uses .Text). All fields validate before writing; multiple updates are ordered, not a frame-atomic transaction.',
    z
      .object({
        ...requestFields,
        input: ref,
        fields: z
          .record(z.string().min(1).max(200), z.string().max(10000))
          .refine(
            (v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 20,
            'Provide 1–20 fields',
          ),
      })
      .strict(),
    false,
    (a) =>
      engine.actions(
        a.request_id,
        Object.entries(a.fields).map(([field, value]) => ({
          type: 'text',
          input: a.input,
          field,
          value: value as string,
        })),
        a.dry_run,
      ),
  );
  tool(
    'vmix_asset_stage',
    'Copy a local media file into the configured asset directory with a SHA-256 filename. VMIX_VISIBLE_ASSET_ROOT can map a Mac-mounted Windows share. Does not import into vMix.',
    z.object({ source_path: z.string().min(1), dry_run: z.boolean().default(false) }).strict(),
    false,
    async (a) => {
      if (config.readOnly && !a.dry_run) throw new Fault('READ_ONLY', 'Asset writes disabled');
      return assets.stage(a.source_path, a.dry_run);
    },
  );
  tool(
    'vmix_input_add',
    'Import a file already visible to vMix, or create a colour input. Returns discovered GUID. Use asset_stage first when bytes need copying. Does not take the input on air.',
    z
      .object({
        ...requestFields,
        type: z.enum(['Video', 'Image', 'Title', 'AudioFile', 'Colour']),
        value: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
      })
      .strict(),
    false,
    async (a) => {
      if (a.type === 'Colour') {
        if (!/^#[a-f\d]{6}$/i.test(a.value)) throw new Fault('COLOUR', 'Use #RRGGBB');
      } else validateMediaPath(a.value);
      return engine.execute(
        a.request_id,
        { kind: 'input_add', type: a.type, value: a.value, name: a.name },
        a.dry_run,
        (s): Command[] => {
          if (a.name && s.inputs.some((i) => i.title === a.name))
            throw new Fault('INPUT_NAME', 'Name already exists');
          return [
            {
              function: 'AddInput',
              params: { Value: `${a.type}|${a.value}` },
              discoversInput: true,
            },
            ...(a.name
              ? [{ function: 'SetInputName', params: { Input: '$created', Value: a.name } }]
              : []),
          ];
        },
      );
    },
  );
  tool(
    'vmix_scene_create',
    'Build an off-air colour-backed scene from existing inputs, with up to 10 layers, pixel rectangles and crop. Pixel coordinates are based on the vMix preset resolution. Never removes inputs on failure.',
    z.object(sceneFields).strict(),
    false,
    (a) =>
      engine.execute(
        a.request_id,
        { kind: 'scene', name: a.name, background: a.background, layers: a.layers },
        a.dry_run,
        (s) => scenePlan(s, a),
      ),
  );
  tool(
    'vmix_scene_template',
    'Build a full, two_up, quad or picture-in-picture scene. Sources must already exist. Canvas dimensions must match your vMix preset; this tool does not change output resolution.',
    z
      .object({
        ...requestFields,
        name: z.string().min(1).max(120),
        layout: z.enum(['full', 'two_up', 'quad', 'pip']),
        sources: z.array(ref).min(1).max(4),
        width: z.number().int().min(320).max(4096).default(3840),
        height: z.number().int().min(240).max(4096).default(2160),
      })
      .strict(),
    false,
    async (a) => {
      const count = { full: 1, two_up: 2, quad: 4, pip: 2 }[
        a.layout as 'full' | 'two_up' | 'quad' | 'pip'
      ];
      if (a.sources.length !== count)
        throw new Fault('LAYOUT_SOURCES', `${a.layout} needs exactly ${count} sources`);
      const w = a.width,
        h = a.height;
      const rectangles: any = {
        full: [[0, 0, w, h]],
        two_up: [
          [0, h / 4, w / 2, h / 2],
          [w / 2, h / 4, w / 2, h / 2],
        ],
        quad: [
          [0, 0, w / 2, h / 2],
          [w / 2, 0, w / 2, h / 2],
          [0, h / 2, w / 2, h / 2],
          [w / 2, h / 2, w / 2, h / 2],
        ],
        pip: [
          [0, 0, w, h],
          [w * 0.66, h * 0.66, w * 0.3, h * 0.3],
        ],
      };
      const args = {
        ...a,
        background: '#000000',
        layers: a.sources.map((source: string, i: number) => {
          const [x, y, width, height] = rectangles[a.layout][i];
          return { source, index: i + 1, rectangle: { x, y, width, height } };
        }),
      };
      return engine.execute(
        a.request_id,
        {
          kind: 'scene_template',
          name: a.name,
          layout: a.layout,
          sources: a.sources,
          width: w,
          height: h,
        },
        a.dry_run,
        (s) => scenePlan(s, args),
      );
    },
  );
  tool(
    'vmix_transition_configure',
    'Configure one of the four native vMix transition buttons: effect and duration. Optionally bind a GT title input to a Stinger slot. Native writes via documented API.',
    z
      .object({
        ...requestFields,
        button: z.number().int().min(1).max(4),
        effect,
        duration_ms: duration,
        gt_input: ref.optional(),
        stinger_slot: z.number().int().min(1).max(8).optional(),
      })
      .strict(),
    false,
    async (a) => {
      if ((a.gt_input === undefined) !== (a.stinger_slot === undefined))
        throw new Fault('STINGER_CONFIG', 'gt_input and stinger_slot must be supplied together');
      const actions: Action[] = [
        {
          type: 'transition_button',
          button: a.button,
          effect: a.effect,
          duration_ms: a.duration_ms,
        },
      ];
      if (a.gt_input)
        actions.unshift({ type: 'stinger_gt', slot: a.stinger_slot, input: a.gt_input });
      return engine.actions(a.request_id, actions, a.dry_run);
    },
  );
  tool(
    'vmix_transition_preset_save',
    'Save a reusable MCP transition preset. Also use transition_configure if you want to modify a native vMix button.',
    z
      .object({
        name: safeName,
        effect,
        duration_ms: duration,
        dry_run: z.boolean().default(false),
      })
      .strict(),
    false,
    async (a) => {
      if (config.readOnly && !a.dry_run) throw new Fault('READ_ONLY', 'Preset changes disabled');
      if (!a.dry_run) {
        store.data.transitions[a.name] = { effect: a.effect, duration_ms: a.duration_ms };
        await store.save();
      }
      return a;
    },
  );
  tool(
    'vmix_transition',
    'Take a specified input on the main program using a saved MCP transition preset; returns state confirmation.',
    z.object({ ...requestFields, input: ref, preset: z.string().min(1) }).strict(),
    false,
    async (a) => {
      const p = store.data.transitions[a.preset];
      if (!p) throw new Fault('PRESET_MISSING', 'Unknown transition preset');
      return engine.execute(
        a.request_id,
        { kind: 'transition', input: a.input, preset: a.preset },
        a.dry_run,
        (s) => compile([{ type: 'transition', input: a.input, ...p }], s),
      );
    },
  );
  tool(
    'vmix_trigger_save',
    'Save a DISARMED MCP-managed trigger. Events are polled state changes, not native vMix triggers. playback_stopped includes manual pauses; playback_time can detect seeks. Default one-shot per arm.',
    z.object({ trigger: triggerSchema, dry_run: z.boolean().default(false) }).strict(),
    false,
    (a) => triggers.put(a.trigger, a.dry_run),
  );
  tool(
    'vmix_trigger_arm',
    'Explicitly arm/disarm a saved managed trigger. No startup/reconnect event catch-up; restarting MCP disarms all triggers. Disarming cancels pending delayed actions.',
    z.object({ id: z.string().min(1), armed: z.boolean() }).strict(),
    false,
    (a) => triggers.arm(a.id, a.armed),
  );
  tool(
    'vmix_trigger_delete',
    'Disarm and remove an MCP-managed trigger definition.',
    z.object({ id: z.string().min(1) }).strict(),
    false,
    (a) => triggers.remove(a.id),
  );
  tool(
    'vmix_configuration',
    'List saved transition presets and MCP-managed triggers, including armed state.',
    z.object({}),
    true,
    async () => ({
      transitions: store.data.transitions,
      triggers: triggers.list(),
      trigger_error: triggers.lastError,
    }),
  );
  tool(
    'vmix_native_setup_guide',
    'Produce concrete native vMix setup steps for a trigger or non-GT Stinger. Read-only: these unsupported settings are NOT written into vMix.',
    z
      .object({
        kind: z.enum(['trigger', 'stinger']),
        input: ref,
        event: z
          .enum([
            'OnTransitionIn',
            'OnTransitionOut',
            'OnOverlayIn',
            'OnOverlayOut',
            'OnCompletion',
          ])
          .optional(),
        actions: z.array(actionSchema).max(20).optional(),
        slot: z.number().int().min(1).max(8).optional(),
        duration_ms: duration.optional(),
        cut_point_ms: duration.optional(),
      })
      .strict(),
    true,
    async (a) => {
      const s = await engine.client.state(),
        i = resolveInput(s, a.input);
      if (a.kind === 'trigger') {
        if (!a.event || !a.actions?.length)
          throw new Fault('TRIGGER_GUIDE', 'Supply event and actions');
        const commands = compile(a.actions, s);
        let delay = 0;
        const rows: any[] = [];
        for (const cmd of commands) {
          if (cmd.delayMs !== undefined) {
            delay += cmd.delayMs;
            continue;
          }
          if (a.event.startsWith('OnTransition') && effect.options.some((e) => e === cmd.function))
            throw new Fault(
              'NATIVE_TRIGGER_LOOP',
              'Native transition-in/out triggers cannot perform transitions; choose another event',
            );
          if (cmd.params.SelectedName)
            throw new Fault(
              'NATIVE_FIELD_BINDING',
              'Native trigger editor field binding is not verified. Use an MCP-managed trigger for named title fields.',
            );
          rows.push({ Trigger: a.event, Function: cmd.function, ...cmd.params, Delay: delay });
          delay = 0;
        }
        if (delay)
          throw new Fault('TRAILING_WAIT', 'Trailing wait has no native trigger action to delay');
        return {
          applied: false,
          input: i,
          steps: [
            'Open Input Settings → Triggers',
            'Add the following rows in order, using the current target input names/GUIDs',
          ],
          rows,
          source: 'https://www.vmix.com/help29/Triggers.html',
        };
      }
      if (
        a.slot === undefined ||
        a.duration_ms === undefined ||
        a.cut_point_ms === undefined ||
        a.cut_point_ms > a.duration_ms
      )
        throw new Fault(
          'STINGER_GUIDE',
          'Supply slot, duration_ms and cut_point_ms within duration',
        );
      return {
        applied: false,
        steps: [
          'Open Overlay settings',
          `Select Stinger ${a.slot}`,
          `Set Stinger Input to ${i.title}`,
          `Set Duration ${a.duration_ms}ms and Stinger Cut Point ${a.cut_point_ms}ms`,
        ],
        note: 'GT titles derive timing from their own animations; use vmix_transition_configure to bind GT input',
        source: 'https://www.vmix.com/help29/StingerTransitions.html',
      };
    },
  );
  let closed = false;
  return {
    server,
    engine,
    triggers,
    async close() {
      if (closed) return;
      closed = true;
      engine.cancelPending();
      await triggers.stop();
      await engine.idle();
      await store.close();
    },
    start() {
      triggers.start();
    },
  };
}
