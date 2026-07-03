// Phase 1.2 spike — real-account hibernation-eviction test.
//
// What this does: opens one WebSocket to the deployed spike worker and
// keeps it open. At increasing idle intervals, it POSTs /deliver/{uuid}
// (simulating the relay's real delivery path) and checks whether the
// message actually arrives on the still-open socket. This is the signal
// Miniflare/local `wrangler dev` cannot produce — real Cloudflare
// hibernation-eviction timing. See spike-do-ws/README.md and
// plans/milestones/relay-serverless-phase-1-summary.md for why this
// matters (it tunes RECONCILIATION_CRON_SCHEDULE in relay_data_model.md
// §9, currently a placeholder 5-minute default).
//
// Usage:
//   node test-hibernation.mjs https://relay-do-ws-spike.mcard-relay.workers.dev
//
// Requires Node 22+ (native `WebSocket` and `fetch`). If your Node is
// older, `npm install ws` and swap the WebSocket import below.
//
// Leave it running. It logs a PASS/FAIL line at each checkpoint and never
// exits on its own — Ctrl+C when you have enough signal (30-60+ min of
// gaps is the useful range; the relay only needs to know the connection
// reliably survives whatever RECONCILIATION_CRON_SCHEDULE ends up being).

const base = process.argv[2];
if (!base) {
  console.error("Usage: node test-hibernation.mjs https://<your-worker>.workers.dev");
  process.exit(1);
}

const httpBase = base.replace(/\/$/, "");
const wsBase = httpBase.replace(/^http/, "ws");
const uuid = `hibernation-test-${Date.now()}`;

// Checkpoints, in minutes since connection open. Extend this list freely.
const checkpointsMin = [1, 2, 5, 10, 20, 30, 45, 60, 90, 120];

const startedAt = Date.now();
let lastMessage = null;

console.log(`[${new Date().toISOString()}] Connecting to ${wsBase}/ws/${uuid}`);
const ws = new WebSocket(`${wsBase}/ws/${uuid}`);

ws.addEventListener("open", () => {
  console.log(`[${new Date().toISOString()}] WS open. Test UUID: ${uuid}`);
  scheduleCheckpoints();
});

ws.addEventListener("message", (event) => {
  lastMessage = { data: event.data, at: Date.now() };
});

ws.addEventListener("close", (event) => {
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(
    `[${new Date().toISOString()}] WS CLOSED after ${elapsedMin} min (code ${event.code}). ` +
    `This itself is a data point — note how long it stayed open unattended.`
  );
});

ws.addEventListener("error", (event) => {
  console.error(`[${new Date().toISOString()}] WS error:`, event.message || event);
});

function scheduleCheckpoints() {
  for (const min of checkpointsMin) {
    setTimeout(() => runCheckpoint(min), min * 60 * 1000);
  }
}

async function runCheckpoint(min) {
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  if (ws.readyState !== WebSocket.OPEN) {
    console.log(`[${new Date().toISOString()}] [t=${elapsedMin}m] SKIP — socket not open (readyState=${ws.readyState})`);
    return;
  }

  lastMessage = null;
  const payload = { text: `checkpoint-${min}min`, sentAt: Date.now() };

  try {
    const res = await fetch(`${httpBase}/deliver/${uuid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] [t=${elapsedMin}m] FAIL — /deliver returned ${res.status}`);
      return;
    }
  } catch (err) {
    console.log(`[${new Date().toISOString()}] [t=${elapsedMin}m] FAIL — /deliver request errored: ${err.message}`);
    return;
  }

  // Give the message a moment to arrive over the socket.
  await new Promise((r) => setTimeout(r, 3000));

  if (lastMessage) {
    console.log(`[${new Date().toISOString()}] [t=${elapsedMin}m] PASS — message received on open socket after ${min}min idle`);
  } else {
    console.log(`[${new Date().toISOString()}] [t=${elapsedMin}m] FAIL — /deliver accepted but no message arrived on socket within 3s`);
  }
}
