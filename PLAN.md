# vMix MCP V0.1 implementation plan

## Deliverable
An independently implemented, runnable TypeScript MCP server for agents configuring and operating vMix. Includes local asset staging/import, input discovery, named reusable transitions, multilayer scenes/layout templates, titles, overlays, playback/replay, ordered action sequences, persistent MCP-managed trigger definitions, examples, a mock vMix and automated MCP integration tests.

## Source of truth and boundaries
- Current user request supersedes the earlier score-service-first proposal: build general vMix engineering tools, not a scoring application or operator UI.
- Official vMix 29 HTTP API / Shortcut Function Reference / Triggers / Stinger documentation; official MCP SDK. Do not copy audited third-party vMix project implementation or protected documentation.
- vMix owns live input/program/overlay/media state. MCP owns named transition presets, managed trigger definitions, request deduplication and operation records. GUIDs identify inputs; names are resolved uniquely at planning time.
- Local files belong to the MCP host. Asset staging copies into a configured root; a mapped vMix-visible root supports a Windows share mounted on Mac. Importing a remote Windows path does not pretend to transfer bytes.
- Native vMix trigger editing and non-GT Stinger media/cut-point editing have no confirmed documented API here. Provide a concrete setup recipe; implement server-managed state-change triggers as a separately named feature. Native transition button effect/duration and SetStingerGTInput1–8 are documented and implemented. No preset reverse engineering or guessed API calls.

## Scope / version goal
V0.1 uses stdio and HTTP polling; runnable on Windows or Mac with path mapping. No live host supplied: use mock acceptance, document real Windows acceptance as open. No client configuration changes, arbitrary shell/script tool, or auto-streaming. User subsequently requested GitHub upload: after validation, create a private repository under the verified authenticated account, commit only this project and push.

## Ordering, persistence, failure
- Schema validation and plan validation precede mutations; changes serialized through one executor.
- Every mutating request has request_id. Persist request fingerprint and operation progress; duplicate IDs return the existing result, mismatches fail. Pending operations after restart become unconfirmed, never replay automatically.
- Whole-response timeout and bounded XML; reject invalid roots, DTDs, missing version, duplicate identities. Never automatically retry mutations.
- Batch failure reports completed steps and partial/unconfirmed effects; never silently deletes created inputs as rollback.
- Dry-run plans resolve all existing input references and reject unsupported operations without mutation. Actual AddInput identity resolved by unique new GUID in state delta; ambiguity stops composition.
- Managed triggers detect explicit observed edges, no startup/reconnect catch-up, no recursive firing during their own action sequence, bounded actions/delay, error disables a trigger. Restart retains definitions but disarms runtime. Polling cannot guarantee frame-accurate or very short event observation; no native OnCompletion equivalence claim.
- Local configuration writes atomic; single-process state directory lock. Trigger and user writes share executor. Disable cancels pending delayed steps.

## Acceptance
1. Build/typecheck and focused unit/integration tests pass.
2. A real MCP SDK client discovers and calls the stdio server against a local mock vMix.
3. End-to-end asset stage/import, two-up or grid scene creation, text update, overlay, named transition and managed trigger are exercised.
4. Error cases: delayed body, malformed XML, HTTP 500, unknown post-send result, duplicate request/restart, invalid reference, path escape/symlink, interrupted batch, reconnect trigger suppression.
5. Package dry run and setup instructions allow Windows-local and Mac-to-Windows-share use; no live-production success claim.

## Sequence
- [x] Workspace and official API inspection; identify unsupported native configuration.
- [x] Implement core transport/state/assets/executor.
- [x] Implement domain tools, persistent presets, managed triggers and recipes.
- [x] Add mock, meaningful regression/MCP integration tests, documentation and examples.
- [x] Run checks, review changes, package and report remaining real-vMix acceptance.

## Validation result
18 local tests passed, including SDK tool calls, imports, layout, field readback, duplicate requests, partial errors, timeout, path mapping, cancellation and restart. The separate real stdio smoke discovered 16 tools and built/took a quad scene against the simulator. Formatting and package dry-run passed. Production dependency audit reported no known vulnerabilities at the time of the check. GitHub CI is configured for Windows/Linux and Node 22/24; real vMix visual/hardware acceptance remains open.

## Review corrections
Fixed POSIX paths misclassified as Windows paths, title image discovery/readback, source GUID checks, schema reserved identifiers, trigger error disarming, cancellation before send, and stale local process lock recovery. No unrelated workspace files or audited third-party source were included.
