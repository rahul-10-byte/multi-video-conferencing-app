const path = require("path");
const puppeteer = require("puppeteer");

const BASE_URL = process.env.BASE_URL || "https://test.heavenhue.in";
const ROOM_COUNT = Number(process.env.ROOM_COUNT || 10);
const USERS_PER_ROOM = Number(process.env.USERS_PER_ROOM || 3);
const HOLD_SECONDS = Number(process.env.HOLD_SECONDS || 120);
const MAX_OPEN_PAGES = Number(process.env.MAX_OPEN_PAGES || 20);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 45000);
const HEADLESS = (process.env.HEADLESS || "true").toLowerCase() !== "false";
const START_STAGGER_MS = Number(process.env.START_STAGGER_MS || 150);
const FAKE_VIDEO_FILE = process.env.FAKE_VIDEO_FILE || "";
const FAKE_AUDIO_FILE = process.env.FAKE_AUDIO_FILE || "";
const BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || "";

function toAbsoluteMaybe(filePath) {
  if (!filePath) return "";
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function buildParticipants() {
  const participants = [];
  for (let room = 0; room < ROOM_COUNT; room += 1) {
    const roomName = `media-room-${room}`;
    for (let index = 0; index < USERS_PER_ROOM; index += 1) {
      participants.push({
        roomName,
        participantId: `bot-${room}-${index}`,
        role: index === 0 ? "agent" : "customer",
        createRoom: index === 0
      });
    }
  }
  return participants;
}

async function setInput(page, selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function joinAsBot(browser, participant) {
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: CONNECT_TIMEOUT_MS });

  await setInput(page, "#backendUrl", BASE_URL);
  await setInput(page, "#participantId", participant.participantId);
  await page.select("#role", participant.role);

  if (participant.createRoom) {
    await setInput(page, "#createRoomName", participant.roomName);
    await page.click("#createRoomBtn");
  } else {
    await setInput(page, "#joinRoomInput", participant.roomName);
    await page.click("#joinRoomBtn");
  }

  await page.waitForFunction(
    () => document.getElementById("connectionState")?.textContent?.toLowerCase().includes("connected"),
    { timeout: CONNECT_TIMEOUT_MS }
  );

  const diagnostics = await page.$eval("#diagnostics", (el) => el.textContent || "");
  const connected = diagnostics.toLowerCase().includes("iceconnectionstate: connected");

  return { page, connected, diagnostics };
}

async function worker(browser, queue, result) {
  while (queue.length > 0) {
    const participant = queue.shift();
    if (!participant) return;
    try {
      const { page, connected, diagnostics } = await joinAsBot(browser, participant);
      if (connected) {
        result.connected += 1;
      } else {
        result.partial += 1;
        result.samples.push({ participantId: participant.participantId, roomName: participant.roomName, diagnostics });
      }
      await new Promise((resolve) => setTimeout(resolve, HOLD_SECONDS * 1000));
      await page.close();
      result.success += 1;
    } catch (error) {
      result.failed += 1;
      result.samples.push({
        participantId: participant.participantId,
        roomName: participant.roomName,
        error: error.message
      });
    }
    await new Promise((resolve) => setTimeout(resolve, START_STAGGER_MS));
  }
}

async function main() {
  const participants = buildParticipants();
  const total = participants.length;
  const concurrency = Math.min(MAX_OPEN_PAGES, total);
  const result = { success: 0, failed: 0, connected: 0, partial: 0, samples: [] };

  console.log(
    JSON.stringify({
      event: "media_bot_start",
      baseUrl: BASE_URL,
      roomCount: ROOM_COUNT,
      usersPerRoom: USERS_PER_ROOM,
      totalParticipants: total,
      holdSeconds: HOLD_SECONDS,
      concurrency,
      fakeVideoFile: FAKE_VIDEO_FILE || null,
      fakeAudioFile: FAKE_AUDIO_FILE || null,
      browserExecutablePath: BROWSER_EXECUTABLE_PATH || null
    })
  );

  const browserArgs = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-setuid-sandbox"
  ];

  const fakeVideoPath = toAbsoluteMaybe(FAKE_VIDEO_FILE);
  const fakeAudioPath = toAbsoluteMaybe(FAKE_AUDIO_FILE);
  if (fakeVideoPath) {
    browserArgs.push(`--use-file-for-fake-video-capture=${fakeVideoPath}`);
  }
  if (fakeAudioPath) {
    browserArgs.push(`--use-file-for-fake-audio-capture=${fakeAudioPath}`);
  }

  const launchOptions = {
    headless: HEADLESS,
    args: browserArgs
  };
  const executablePath = toAbsoluteMaybe(BROWSER_EXECUTABLE_PATH);
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const queue = [...participants];
    const workers = Array.from({ length: concurrency }).map(() => worker(browser, queue, result));
    await Promise.all(workers);
  } finally {
    await browser.close();
  }

  console.log(
    JSON.stringify({
      event: "media_bot_summary",
      totalParticipants: total,
      success: result.success,
      failed: result.failed,
      connectedIce: result.connected,
      partialIce: result.partial,
      sampleErrors: result.samples.slice(0, 10)
    })
  );

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const hint =
    error && error.message && error.message.includes("spawn UNKNOWN")
      ? "Browser launch failed. Install Chrome for Testing with `npx puppeteer browsers install chrome` or set BROWSER_EXECUTABLE_PATH to local Chrome."
      : null;
  console.error(JSON.stringify({ event: "media_bot_fatal", error: error.message, hint }));
  process.exit(1);
});
