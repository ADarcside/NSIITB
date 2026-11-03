// Smoke test against a running relay: node scripts/smoke.mjs [ws://127.0.0.1:8787]
// Creates a room with cap 2, joins a second player, checks pose relay, and that a 3rd is refused.
const base = process.argv[2] ?? 'ws://127.0.0.1:8787';
const code = 'TEST' + 'ABCDEFGHJK'[Math.floor(Math.random() * 10)] + 'Z';
const look = { char: 'kid', colors: ['#ff0000', '#00ff00', '#0000ff'], hat: 'none' };
const open = (name, create) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/room/${code}`);
    const msgs = [];
    ws.onmessage = e => msgs.push(JSON.parse(e.data));
    ws.onerror = reject;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', v: 1, name, look, scene: 'dev', cap: 2, create }));
      resolve({ ws, msgs });
    };
  });
const wait = ms => new Promise(r => setTimeout(r, ms));
const fail = m => {
  console.error('FAIL:', m);
  process.exit(1);
};
const a = await open('A', true);
await wait(300);
const b = await open('B', false);
await wait(300);
if (a.msgs[0]?.t !== 'welcome') fail('A not welcomed ' + JSON.stringify(a.msgs));
if (b.msgs[0]?.t !== 'welcome' || b.msgs[0].peers.length !== 1) fail('B not welcomed with A');
a.ws.send(JSON.stringify({ t: 's', p: [1, 1.5, 2, 0, 0] }));
await wait(300);
if (!b.msgs.some(m => m.t === 's' && m.p[0] === 1)) fail('pose not relayed');
const c = await open('C', false);
await wait(300);
if (c.msgs[0]?.code !== 'full') fail('3rd not refused: ' + JSON.stringify(c.msgs));
console.log('relay smoke test passed for room', code);
process.exit(0);
