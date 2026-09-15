import { setTimeout as sleep } from 'node:timers/promises';
import { Store, fingerprint, type Operation } from './store.js';
import { VmixClient, Fault, type State } from './vmix.js';
import { compile, type Action, type Command } from './actions.js';
import type { Config } from './config.js';

export class Engine {
  private tail: Promise<unknown> = Promise.resolve();
  private stopping = new AbortController();
  busy = false;
  constructor(
    public client: VmixClient,
    public store: Store,
    public config: Config,
  ) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => {});
    return p;
  }
  async idle() {
    await this.tail;
  }
  cancelPending() {
    this.stopping.abort();
  }
  async execute(
    id: string,
    payload: unknown,
    dry: boolean,
    build: (state: State) => Command[],
    signal?: AbortSignal,
  ): Promise<any> {
    signal = signal ? AbortSignal.any([signal, this.stopping.signal]) : this.stopping.signal;
    return this.serial(async () => {
      const hash = fingerprint(payload);
      if (!dry) {
        if (this.config.readOnly) throw new Fault('READ_ONLY', 'Server is configured read-only');
        const old = this.store.data.operations[id];
        if (old) {
          if (old.fingerprint !== hash)
            throw new Fault(
              'REQUEST_CONFLICT',
              'request_id already belongs to different parameters',
            );
          return old;
        }
      }
      this.busy = true;
      try {
        if (signal?.aborted) throw new Fault('CANCELLED', 'Pending operation cancelled');
        const state = await this.client.state();
        const plan = build(structuredClone(state));
        if (plan.length > 100) throw new Fault('PLAN_LIMIT', 'Maximum 100 commands per operation');
        if (dry)
          return {
            dry_run: true,
            commands: plan,
            note: 'No changes sent; dynamic input identities are resolved during execution',
          };
        const op: Operation = {
          id,
          fingerprint: hash,
          status: 'running',
          startedAt: new Date().toISOString(),
          steps: [],
        };
        this.store.data.operations[id] = op;
        await this.store.save();
        let created: string | undefined;
        let current: Command | undefined;
        try {
          for (const command of plan) {
            if (signal?.aborted) throw new Fault('CANCELLED', 'Pending steps cancelled');
            current = command;
            if (command.delayMs !== undefined) {
              await sleep(command.delayMs, undefined, { signal });
              op.steps.push({ function: 'wait', status: 'completed', ms: command.delayMs });
              continue;
            }
            // Refresh identity just before each command; never fall back to input numbers for target.
            const fresh = await this.client.state();
            const params = { ...command.params };
            if (params.Input === '$created') {
              if (!created) throw new Fault('INPUT_DISCOVERY', 'No uniquely identified new input');
              params.Input = created;
            }
            if (params.Input && !fresh.inputs.some((i) => i.key === params.Input))
              throw new Fault('INPUT_REFERENCE', 'Pinned target input no longer exists');
            if (command.layerSource) {
              const src = fresh.inputs.find((i) => i.key === command.layerSource);
              if (!src) throw new Fault('INPUT_REFERENCE', 'Pinned layer source no longer exists');
              params.Value = `${params.Value!.split(',')[0]},${src.number}`;
            }
            if (signal?.aborted) throw new Fault('CANCELLED', 'Pending command cancelled');
            const step = {
              function: command.function,
              params,
              status: 'sending',
              verification: 'not_observed',
            };
            op.steps.push(step);
            await this.store.save();
            if (signal?.aborted)
              throw new Fault('CANCELLED', 'Pending command cancelled before send');
            await this.client.command(command.function, params);
            step.status = 'api_accepted';
            await this.store.save();
            if (command.discoversInput) {
              const found = await this.observe((s) => {
                const added = s.inputs.filter(
                  (i) => !fresh.inputs.some((before) => before.key === i.key),
                );
                if (added.length > 1)
                  throw new Fault(
                    'INPUT_DISCOVERY',
                    'Multiple inputs appeared; cannot safely identify ours',
                    true,
                  );
                const expected = params.Value!.split('|')[0];
                if (added[0] && added[0].type !== (expected === 'Title' ? 'GT' : expected))
                  throw new Fault(
                    'INPUT_DISCOVERY',
                    'New input type does not match import; cannot safely identify ours',
                    true,
                  );
                return added.length === 1 ? added[0]!.key : undefined;
              });
              if (!found)
                throw new Fault(
                  'INPUT_DISCOVERY',
                  'New input not observable; inspect vMix, do not blindly repeat AddInput',
                  true,
                );
              created = found;
              op.result = { created_input: created };
              step.verification = 'input_guid_observed';
            } else {
              const verify = command.layerSource
                ? (s: State) =>
                    s.inputs
                      .find((i) => i.key === params.Input)
                      ?.layers.some(
                        (l) =>
                          l.index === Number(params.Value!.split(',')[0]) &&
                          l.key === command.layerSource,
                      )
                      ? (true as const)
                      : undefined
                : this.verifier(command.function, params);
              if (verify) {
                if (
                  !(await this.observe(
                    verify,
                    this.config.timeoutMs + Number(params.Duration ?? 0),
                  ))
                )
                  throw new Fault(
                    'NOT_CONFIRMED',
                    'API accepted command, but expected state was not observed',
                    true,
                  );
                step.verification = 'state_observed';
              }
            }
            await this.store.save();
            current = undefined;
          }
          op.status = 'completed';
          op.result = {
            created_input: created,
            note: 'See each step: API acceptance and observed state are distinct; visual timing/audio require vMix monitoring',
          };
        } catch (error) {
          const uncertain =
            (error instanceof Fault && error.uncertain) ||
            (op.steps.at(-1) as any)?.status === 'sending' ||
            (op.steps.at(-1) as any)?.status === 'api_accepted';
          op.status = uncertain ? 'unconfirmed' : op.steps.length ? 'partial' : 'failed';
          op.error = {
            code: error instanceof Fault ? error.code : 'EXECUTION_ERROR',
            message: error instanceof Error ? error.message : 'Unknown failure',
            command: current?.function,
            recovery:
              'Inspect live state and completed steps. Use a new request_id only after reconciliation; no automatic rollback/retry.',
          };
        }
        op.finishedAt = new Date().toISOString();
        await this.store.save();
        return op;
      } finally {
        this.busy = false;
      }
    });
  }
  async actions(id: string, actions: Action[], dry = false, signal?: AbortSignal) {
    return this.execute(id, { kind: 'actions', actions }, dry, (s) => compile(actions, s), signal);
  }
  private async observe<T>(
    test: (s: State) => T | undefined,
    timeout = this.config.timeoutMs,
  ): Promise<T | undefined> {
    const end = Date.now() + timeout;
    do {
      const value = test(await this.client.state());
      if (value) return value;
      await sleep(50);
    } while (Date.now() < end);
    return undefined;
  }
  private verifier(
    fn: string,
    p: Record<string, string>,
  ): ((s: State) => true | undefined) | undefined {
    if (fn === 'PreviewInput') return (s) => (s.preview === p.Input ? true : undefined);
    if (fn === 'SetInputName')
      return (s) => (s.inputs.find((i) => i.key === p.Input)?.title === p.Value ? true : undefined);
    if (fn === 'SetText')
      return (s) =>
        s.inputs
          .find((i) => i.key === p.Input)
          ?.texts.some((t) => t.name === p.SelectedName && t.value === p.Value)
          ? true
          : undefined;
    if (fn === 'SetImage')
      return (s) =>
        s.inputs
          .find((i) => i.key === p.Input)
          ?.images.some((t) => t.name === p.SelectedName && t.value === p.Value)
          ? true
          : undefined;
    if (
      [
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
        ...Array.from({ length: 8 }, (_, i) => `Stinger${i + 1}`),
      ].includes(fn)
    )
      return (s) => (s.active === p.Input ? true : undefined);
    const overlay = /^OverlayInput([1-8])(In|Out)$/.exec(fn);
    if (overlay)
      return (s) => {
        const key = s.overlays.find((o) => o.number === Number(overlay[1]))?.key;
        return (overlay[2] === 'In' ? key === p.Input : key == null) ? true : undefined;
      };
    return undefined;
  }
}
