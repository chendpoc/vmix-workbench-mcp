# Architecture and acceptance

## Ownership

`VmixClient` owns bounded HTTP requests and strict state parsing. vMix remains authoritative for program, preview, input identity, overlays and media. `Engine` owns serialized writes, immutable request fingerprints, command progress and scoped readback. `Store` owns atomic JSON state replacement and the single-process lock. `Assets` owns permitted source roots, copied-byte hashing and path mapping. `Triggers` owns polling edges and cancellable, bounded rule runs. MCP handlers validate schemas and expose domain tools.

Input names resolve once to GUIDs. Layer source numbers are derived from those pinned GUIDs immediately before the documented SetLayer command, then checked against observed layer GUIDs. A competing manual edit can still race the API: no distributed lock exists in vMix. Do not concurrently build layouts from several controllers.

## Failure semantics

The operation is persisted before sending commands. Each step is recorded before send and after acknowledgement. A crash between send and persistence leaves an interrupted operation; startup marks it unconfirmed. Requests are not re-executed on startup. Repeating request_id returns the prior operation even if failed. Changing parameters under that ID fails.

Whole-body HTTP deadlines, a response size limit, disabled redirects, DTD rejection and structural validation prevent malformed/incorrect endpoints from appearing healthy. No mutation retries occur automatically. An HTTP error is conservatively treated as potentially having partial effects. No unsafe automatic rollback deletes user inputs.

Stored operation history is a small-project implementation using whole-file snapshots; it is not a high-throughput event database. Use a separate data directory per production and archive completed show data only after stopping the process. Do not reuse old IDs after removing history.

AddInput returns no creation token. Discovery compares state snapshots and requires one new, type-matching GUID. This is a single-controller assumption, not transaction isolation. Some input types may use a different XML type in specific vMix versions; mismatches stop with an unconfirmed result rather than guessing ownership.

## Trigger lifecycle

Save → disarmed → explicit arm with fresh baseline → observe edge → execute via Engine → disarm at limit/error. There is no native trigger installation. Reconnect creates a new baseline. Defaults: one firing per arm, 1 second cooldown, 20 actions, 30 seconds combined wait. Pending waits and unsent commands are cancelled on disarm/shutdown; a command already sent cannot be undone.

The trigger runner does not interpret its own executed sequence as a new edge. This prevents self-induced loops but also means it intentionally does not chain managed triggers. Polling can miss short states. Several rules that match the same observed edge are not a broadcast fan-out: one rule is processed, then a new baseline is acquired. Put actions for one event in one rule.

Native trigger recipes are informational and return applied:false. The guide rejects native transition-in/out loops and unverified title-field bindings. Non-GT Stinger cut points remain manual; native transition button settings and GT Stinger binding use documented functions directly. Merely being a GT input does not prove it contains a suitable transition animation.

## Real Windows/vMix acceptance still required

1. Verify exact version, API authentication and returned XML for camera, GT, Colour, Image, Video and AudioFile inputs.
2. Import real image/video/title/audio files; confirm staging paths resolve to the same bytes, and failed imports do not get reported as confirmed.
3. Build 4K two-up, quad and PIP. Check SetLayerRectangle coordinates, aspect ratio, crop and title alpha in actual output. These tests validate API command assembly, not visual composition.
4. Configure native button effect/duration and GT Stinger source. Verify animation timing and native settings; ordinary videos use the manual setup guide.
5. Exercise Chinese text/image updates and overlay show/hide; multiple fields can update across different frames.
6. Arm a rule, transition manually, observe one firing; disarm during a delay, disconnect/reconnect, restart the MCP process, and confirm no stale action fires.
7. Interrupt a scene build, inspect its persisted steps and created GUID, then reconcile before issuing a new request. Test manual changes between commands.
8. Rehearse the actual 3–4 camera 4K replay/graphics/output workload and independently test manual takeover. No automatic scoring or highlight recognition is included.

## Review record

Local validation uses a protocol-level mock plus a real stdio SDK client. Mock command handling rejects unknown functions and models GUID identity, layer indices, overlays and field readback. Explicit fault injection covers HTTP failure, delayed response bodies, accepted commands without state change, bad XML, source symlink escape, duplicate requests, process restart and trigger cancellation. GitHub CI adds Windows/Linux Node 22/24 execution; hardware/codec/visual correctness remains open.
