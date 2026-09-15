import { z } from 'zod';
import { Fault, resolveInput, type State } from './vmix.js';
import { validateMediaPath } from './assets.js';

export const ref = z.string().min(1).max(200);
export const safeName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,80}$/)
  .refine((v) => !Object.hasOwn(Object.prototype, v), 'Reserved name');
export const requestFields = {
  request_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,140}$/)
    .refine((v) => !Object.hasOwn(Object.prototype, v), 'Reserved request ID'),
  dry_run: z.boolean().default(false),
};
export const effect = z.enum([
  'Cut',
  'Fade',
  'Merge',
  'Zoom',
  'Wipe',
  'Slide',
  'Fly',
  'CrossZoom',
  'FlyRotate',
  'Cube',
  'CubeZoom',
  'VerticalWipe',
  'VerticalSlide',
  'Stinger1',
  'Stinger2',
  'Stinger3',
  'Stinger4',
  'Stinger5',
  'Stinger6',
  'Stinger7',
  'Stinger8',
]);
export const duration = z.number().int().min(0).max(30000);
export const rect = z
  .object({
    x: z.number().min(-4096).max(4096),
    y: z.number().min(-4096).max(4096),
    width: z.number().positive().max(4096),
    height: z.number().positive().max(4096),
  })
  .strict();
export const crop = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preview'), input: ref }).strict(),
  z
    .object({
      type: z.literal('transition'),
      input: ref,
      effect,
      duration_ms: duration.default(500),
    })
    .strict(),
  z
    .object({
      type: z.literal('overlay'),
      input: ref.optional(),
      channel: z.number().int().min(1).max(8),
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({ type: z.literal('text'), input: ref, field: ref, value: z.string().max(10000) })
    .strict(),
  z.object({ type: z.literal('image'), input: ref, field: ref, path: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('playback'),
      input: ref,
      command: z.enum(['Play', 'Pause', 'Restart', 'LoopOn', 'LoopOff']),
    })
    .strict(),
  z
    .object({
      type: z.literal('audio'),
      input: ref,
      volume: z.number().min(0).max(100).optional(),
      muted: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('layer'),
      input: ref,
      source: ref,
      index: z.number().int().min(1).max(10),
      rectangle: rect.optional(),
      crop: crop.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transition_button'),
      button: z.number().int().min(1).max(4),
      effect,
      duration_ms: duration,
    })
    .strict(),
  z
    .object({ type: z.literal('stinger_gt'), slot: z.number().int().min(1).max(8), input: ref })
    .strict(),
  z
    .object({
      type: z.literal('replay'),
      command: z.enum(['play', 'pause', 'speed', 'mark_last']),
      channel: z.enum(['A', 'B']).default('A'),
      speed: z.number().min(0).max(1).optional(),
      seconds: z.number().int().min(1).max(120).optional(),
    })
    .strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(30000) }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export interface Command {
  function: string;
  params: Record<string, string>;
  layerSource?: string;
  delayMs?: number;
  discoversInput?: boolean;
}
const c = (f: string, params: Record<string, string> = {}): Command => ({ function: f, params });
export function compile(actions: Action[], state: State): Command[] {
  if (actions.reduce((s, a) => s + (a.type === 'wait' ? a.ms : 0), 0) > 30000)
    throw new Fault('PLAN_LIMIT', 'Combined wait time must not exceed 30 seconds');
  return actions.flatMap((a) => {
    const input = 'input' in a && a.input ? resolveInput(state, a.input) : undefined;
    const key = input?.key ?? '';
    switch (a.type) {
      case 'wait':
        return [{ function: 'wait', params: {}, delayMs: a.ms }];
      case 'preview':
        return [c('PreviewInput', { Input: key })];
      case 'transition':
        return [
          c(a.effect, {
            Input: key,
            ...(a.effect.startsWith('Stinger') ? {} : { Duration: String(a.duration_ms) }),
          }),
        ];
      case 'overlay':
        if (a.visible && !input)
          throw new Fault('INPUT_REFERENCE', 'A visible overlay requires input');
        return [
          c(`OverlayInput${a.channel}${a.visible ? 'In' : 'Out'}`, a.visible ? { Input: key } : {}),
        ];
      case 'text':
        if (!input!.texts.some((t) => t.name === a.field))
          throw new Fault(
            'TITLE_FIELD',
            `Unknown text field: ${a.field}; inspect input fields first`,
          );
        return [c('SetText', { Input: key, SelectedName: a.field, Value: a.value })];
      case 'image':
        validateMediaPath(a.path);
        if (!input!.images.some((t) => t.name === a.field))
          throw new Fault(
            'TITLE_FIELD',
            `Unknown image field: ${a.field}; inspect input fields first`,
          );
        return [c('SetImage', { Input: key, SelectedName: a.field, Value: a.path })];
      case 'playback':
        return [c(a.command, { Input: key })];
      case 'audio':
        if (a.volume === undefined && a.muted === undefined)
          throw new Fault('EMPTY_ACTION', 'Set volume or muted');
        return [
          ...(a.volume !== undefined
            ? [c('SetVolume', { Input: key, Value: String(a.volume) })]
            : []),
          ...(a.muted !== undefined ? [c(a.muted ? 'AudioOff' : 'AudioOn', { Input: key })] : []),
        ];
      case 'layer': {
        const source = resolveInput(state, a.source);
        if (source.key === key) throw new Fault('LAYER_CYCLE', 'An input cannot contain itself');
        // Reject indirect existing cycles before modifying the layer graph.
        const reaches = (from: string, seen = new Set<string>()): boolean => {
          if (from === key) return true;
          if (seen.has(from)) return false;
          seen.add(from);
          return (
            state.inputs.find((i) => i.key === from)?.layers.some((l) => reaches(l.key, seen)) ??
            false
          );
        };
        if (reaches(source.key)) throw new Fault('LAYER_CYCLE', 'Layer would create a cycle');
        if (a.crop && (a.crop[0] >= a.crop[2] || a.crop[1] >= a.crop[3]))
          throw new Fault('CROP', 'Crop must have positive width and height');
        const layer = input!.layers.find((l) => l.index === a.index);
        if (layer) layer.key = source.key;
        else input!.layers.push({ index: a.index, key: source.key });
        const commands = [
          {
            ...c('SetLayer', { Input: key, Value: `${a.index},${source.number}` }),
            layerSource: source.key,
          },
        ];
        const rest: Command[] = [];
        if (a.rectangle) {
          const r = a.rectangle;
          rest.push(
            c(`SetLayer${a.index}Rectangle`, {
              Input: key,
              Value: `${r.x},${r.y},${r.width},${r.height}`,
            }),
          );
        }
        if (a.crop) rest.push(c(`SetLayer${a.index}Crop`, { Input: key, Value: a.crop.join(',') }));
        return [...commands, ...rest];
      }
      case 'transition_button':
        return [
          c(`SetTransitionEffect${a.button}`, { Value: a.effect }),
          c(`SetTransitionDuration${a.button}`, { Value: String(a.duration_ms) }),
        ];
      case 'stinger_gt':
        if (input!.type !== 'GT')
          throw new Fault('INPUT_TYPE', 'SetStingerGTInput requires a GT title input');
        return [c(`SetStingerGTInput${a.slot}`, { Input: key })];
      case 'replay':
        if (!state.inputs.some((i) => i.type === 'Replay'))
          throw new Fault(
            'REPLAY_UNAVAILABLE',
            'No Replay input found; configure a replay session first',
          );
        if (a.command === 'mark_last') {
          if (a.seconds === undefined)
            throw new Fault('REPLAY_SECONDS', 'mark_last requires seconds');
          return [c('ReplayMarkInOutLive', { Value: String(a.seconds) })];
        }
        if (a.command === 'speed') {
          if (a.speed === undefined)
            throw new Fault('REPLAY_SPEED', 'speed command requires speed');
          return [c('ReplaySetSpeed', { Channel: a.channel, Value: String(a.speed) })];
        }
        return [c(a.command === 'play' ? 'ReplayPlay' : 'ReplayPause', { Channel: a.channel })];
    }
  });
}
