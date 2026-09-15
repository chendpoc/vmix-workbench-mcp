import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const escape = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export async function startMock(port = 0) {
  const input = (title, type = 'Capture') => ({
    key: randomUUID(),
    title,
    type,
    state: 'Paused',
    position: 0,
    duration: 10000,
    texts: [],
    images: [],
    layers: [],
    loop: false,
  });
  const inputs = [
    input('Camera 1'),
    input('Camera 2'),
    input('Camera 3'),
    input('Camera 4'),
    input('Scoreboard', 'GT'),
    input('Replay A', 'Replay'),
  ];
  inputs[4].texts = [
    { name: 'Score.Text', value: '0 : 0' },
    { name: 'Player.Text', value: '选手' },
  ];
  inputs[4].images = [{ name: 'Photo.Source', value: 'C:\\placeholder.png' }];
  const model = {
    inputs,
    active: inputs[0].key,
    preview: inputs[1].key,
    overlays: {},
    commands: [],
    failFunction: undefined,
    ignoreFunction: undefined,
    delayBodyMs: 0,
    invalidXml: false,
    transitionButtons: {},
  };
  const xml = () =>
    `<vmix><version>29.0.0.0</version><edition>Pro</edition><inputs>${model.inputs
      .map(
        (i, n) =>
          `<input key="${i.key}" number="${n + 1}" title="${escape(i.title)}" type="${i.type}" state="${i.state}" position="${i.position}" duration="${i.duration}" loop="${i.loop}">${i.texts.map((t) => `<text name="${escape(t.name)}">${escape(t.value)}</text>`).join('')}${i.images.map((t) => `<image name="${escape(t.name)}">${escape(t.value)}</image>`).join('')}${i.layers.map((l) => `<overlay index="${l.index - 1}" key="${l.key}"/>`).join('')}</input>`,
      )
      .join(
        '',
      )}</inputs><active>${model.inputs.findIndex((i) => i.key === model.active) + 1}</active><preview>${model.inputs.findIndex((i) => i.key === model.preview) + 1}</preview><overlays>${Array.from({ length: 8 }, (_, i) => `<overlay number="${i + 1}">${model.overlays[i + 1] ? model.inputs.findIndex((x) => x.key === model.overlays[i + 1]) + 1 : ''}</overlay>`).join('')}</overlays><recording>False</recording><streaming>False</streaming></vmix>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (!u.pathname.startsWith('/api')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const p = Object.fromEntries(u.searchParams),
      fn = p.Function;
    if (!fn) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.flushHeaders();
      setTimeout(
        () => res.end(model.invalidXml ? '<html>not vMix</html>' : xml()),
        model.delayBodyMs,
      );
      return;
    }
    model.commands.push(p);
    const i = model.inputs.find((x) => x.key === p.Input);
    try {
      if (fn === model.failFunction) throw new Error('Injected API failure');
      if (fn === model.ignoreFunction) {
        res.writeHead(200);
        res.end('OK');
        return;
      }
      if (fn === 'AddInput') {
        const type = p.Value.split('|')[0];
        model.inputs.push(input(p.Value, type === 'Title' ? 'GT' : type));
      } else if (fn === 'SetInputName') {
        if (!i) throw new Error('Input missing');
        i.title = p.Value;
      } else if (fn === 'PreviewInput') {
        if (!i) throw new Error('Input missing');
        model.preview = i.key;
      } else if (
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
      ) {
        if (!i) throw new Error('Input missing');
        const old = model.active;
        model.active = i.key;
        model.preview = old;
      } else if (/^OverlayInput[1-8](In|Out)$/.test(fn)) {
        const channel = Number(fn.match(/\d/)[0]);
        if (fn.endsWith('In')) {
          if (!i) throw new Error('Input missing');
          model.overlays[channel] = i.key;
        } else delete model.overlays[channel];
      } else if (fn === 'SetText') {
        const t = i?.texts.find((t) => t.name === p.SelectedName);
        if (!t) throw new Error('Text missing');
        t.value = p.Value;
      } else if (fn === 'SetLayer') {
        if (!i) throw new Error('Input missing');
        const [n, source] = p.Value.split(',').map(Number);
        const src = model.inputs[source - 1];
        if (!src) throw new Error('Source missing');
        const l = i.layers.find((x) => x.index === n);
        if (l) l.key = src.key;
        else i.layers.push({ index: n, key: src.key });
      } else if (/^SetLayer\d+(Rectangle|Crop)$/.test(fn)) {
        if (!i) throw new Error('Input missing');
      } else if (/^SetTransition(Effect|Duration)[1-4]$/.test(fn)) {
        model.transitionButtons[fn] = p.Value;
      } else if (/^SetStingerGTInput[1-8]$/.test(fn)) {
        if (i?.type !== 'GT') throw new Error('Expected GT input');
      } else if (fn === 'SetImage') {
        const image = i?.images.find((t) => t.name === p.SelectedName);
        if (!image) throw new Error('Image field missing');
        image.value = p.Value;
      } else if (
        [
          'Play',
          'Pause',
          'Restart',
          'LoopOn',
          'LoopOff',
          'SetVolume',
          'AudioOn',
          'AudioOff',
        ].includes(fn)
      ) {
        if (!i) throw new Error('Input missing');
        if (fn === 'Play') i.state = 'Running';
        if (fn === 'Pause') i.state = 'Paused';
        if (fn === 'Restart') i.position = 0;
      } else if (
        ['ReplayPlay', 'ReplayPause', 'ReplayMarkInOutLive', 'ReplaySetSpeed'].includes(fn)
      ) {
        if (fn === 'ReplaySetSpeed' && !(Number(p.Value) >= 0 && Number(p.Value) <= 1))
          throw new Error('Invalid replay speed');
      } else throw new Error(`Unknown mock command ${fn}`);
      res.writeHead(200);
      res.end('OK');
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    model,
    xml,
    url: `http://127.0.0.1:${server.address().port}/api/`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMock(Number(process.env.MOCK_PORT ?? 8098));
  console.log(`Mock vMix only: ${mock.url}`);
  process.once('SIGINT', async () => {
    await mock.close();
    process.exit(0);
  });
}
