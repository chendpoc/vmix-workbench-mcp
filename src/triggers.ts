import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { actionSchema, compile, ref, safeName, type Action } from './actions.js';
import { Engine } from './engine.js';
import { Fault, resolveInput, type State } from './vmix.js';

export const triggerSchema = z
  .object({
    id: safeName,
    input: ref,
    event: z.enum([
      'program_enter',
      'program_leave',
      'overlay_enter',
      'overlay_leave',
      'playback_stopped',
      'playback_time',
    ]),
    channel: z.number().int().min(1).max(8).optional(),
    at_ms: z.number().int().min(0).optional(),
    actions: z.array(actionSchema).min(1).max(20),
    max_fires: z.number().int().min(1).max(100).default(1),
    cooldown_ms: z.number().int().min(1000).max(60000).default(1000),
  })
  .strict();
export type Trigger = z.infer<typeof triggerSchema>;
export function edge(t: Trigger, before: State, after: State): boolean {
  const a = before.inputs.find((i) => i.key === t.input),
    b = after.inputs.find((i) => i.key === t.input);
  if (!a || !b) return false;
  switch (t.event) {
    case 'program_enter':
      return before.active !== t.input && after.active === t.input;
    case 'program_leave':
      return before.active === t.input && after.active !== t.input;
    case 'overlay_enter':
      return (
        before.overlays.find((o) => o.number === t.channel)?.key !== t.input &&
        after.overlays.find((o) => o.number === t.channel)?.key === t.input
      );
    case 'overlay_leave':
      return (
        before.overlays.find((o) => o.number === t.channel)?.key === t.input &&
        after.overlays.find((o) => o.number === t.channel)?.key !== t.input
      );
    case 'playback_stopped':
      return a.state === 'Running' && b.state === 'Paused';
    case 'playback_time':
      return (
        a.state === 'Running' &&
        b.state === 'Running' &&
        a.position < t.at_ms! &&
        b.position >= t.at_ms!
      );
  }
}
export class Triggers {
  private runtime = new Map<
    string,
    { controller: AbortController; count: number; last: number; epoch: number }
  >();
  private previous?: State;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private epoch = 0;
  private polling?: Promise<void>;
  lastError?: string;
  constructor(private engine: Engine) {}
  start() {
    this.active = true;
    this.schedule();
  }
  private schedule() {
    if (this.active)
      this.timer = setTimeout(() => {
        this.polling = this.tick().finally(() => this.schedule());
      }, this.engine.config.pollMs);
  }
  async stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    for (const r of this.runtime.values()) r.controller.abort();
    this.runtime.clear();
    await this.polling;
  }
  list() {
    return Object.values(this.engine.store.data.triggers).map((t) => ({
      ...t,
      armed: this.runtime.has(t.id),
      fires_this_arm: this.runtime.get(t.id)?.count ?? 0,
      runtime: 'MCP process polling; not a native vMix trigger',
    }));
  }
  async put(raw: Trigger, dry: boolean) {
    if (this.engine.config.readOnly && !dry)
      throw new Fault('READ_ONLY', 'Trigger changes disabled');
    const state = await this.engine.client.state();
    const t = structuredClone(raw);
    t.input = resolveInput(state, t.input).key;
    t.actions = t.actions.map((a: Action) => {
      const v = { ...a };
      if ('input' in v && v.input) v.input = resolveInput(state, v.input).key;
      if ('source' in v) v.source = resolveInput(state, v.source).key;
      return v;
    });
    compile(t.actions, structuredClone(state));
    if (t.event.startsWith('overlay') && t.channel === undefined)
      throw new Fault('TRIGGER_CHANNEL', 'Overlay event requires channel');
    if (t.event === 'playback_time' && t.at_ms === undefined)
      throw new Fault('TRIGGER_TIME', 'playback_time requires at_ms');
    if (!dry) {
      this.disarm(t.id);
      this.engine.store.data.triggers[t.id] = t;
      await this.engine.store.save();
    }
    return {
      dry_run: dry,
      trigger: t,
      armed: false,
      note: 'Saved as an MCP-managed trigger; arm explicitly after checking its actions',
    };
  }
  async arm(id: string, armed: boolean) {
    if (this.engine.config.readOnly) throw new Fault('READ_ONLY', 'Trigger changes disabled');
    const t = this.engine.store.data.triggers[id] as Trigger | undefined;
    if (!t) throw new Fault('TRIGGER_MISSING', 'Unknown trigger id');
    this.disarm(id);
    if (armed) {
      const state = await this.engine.client.state();
      resolveInput(state, t.input);
      compile(t.actions, structuredClone(state));
      // Reset the shared baseline on arming: no historical event catch-up for any rule.
      this.previous = state;
      this.runtime.set(id, {
        controller: new AbortController(),
        count: 0,
        last: 0,
        epoch: ++this.epoch,
      });
    }
    return { id, armed };
  }
  disarm(id: string) {
    this.runtime.get(id)?.controller.abort();
    this.runtime.delete(id);
  }
  async remove(id: string) {
    if (this.engine.config.readOnly) throw new Fault('READ_ONLY', 'Trigger changes disabled');
    this.disarm(id);
    delete this.engine.store.data.triggers[id];
    await this.engine.store.save();
    return { id, deleted: true };
  }
  async tick() {
    if (!this.runtime.size || this.engine.busy) return;
    try {
      const state = await this.engine.client.state();
      this.lastError = undefined;
      const before = this.previous;
      this.previous = state;
      if (!before) return;
      for (const [id, r] of this.runtime) {
        const t = this.engine.store.data.triggers[id] as Trigger;
        if (!t || !edge(t, before, state) || Date.now() - r.last < t.cooldown_ms) continue;
        r.last = Date.now();
        r.count++;
        let op;
        try {
          op = await this.engine.actions(
            `trigger-${id}-${randomUUID()}`,
            t.actions,
            false,
            r.controller.signal,
          );
        } catch (error) {
          this.disarm(id);
          throw error;
        }
        if (this.engine.store.data.triggers[id]) {
          this.engine.store.data.triggers[id].last_operation = op.id;
          await this.engine.store.save();
        }
        if (this.runtime.get(id) === r && (op.status !== 'completed' || r.count >= t.max_fires))
          this.disarm(id);
        // Own action sequence is never fed back into another edge evaluation.
        this.previous = await this.engine.client.state();
        break;
      }
    } catch (error) {
      this.previous = undefined;
      this.lastError = error instanceof Error ? error.message : 'Trigger polling failed';
    }
  }
}
