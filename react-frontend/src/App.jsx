import { useEffect, useMemo, useRef, useState } from 'react';
import { buildWsUrl, normalizeBackendUrl, requestJson, slugifyParticipantId } from './lib/backend';

const initialMessages = [];

function initialsFromName(name) {
  return String(name || 'Guest')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

function createSocketClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;

  const cleanup = () => {
    for (const pendingItem of pending.values()) {
      clearTimeout(pendingItem.timer);
      pendingItem.reject(new Error('socket_closed'));
    }
    pending.clear();
  };

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.requestId && pending.has(message.requestId)) {
      const pendingItem = pending.get(message.requestId);
      clearTimeout(pendingItem.timer);
      pending.delete(message.requestId);
      if (message.event === 'error') {
        pendingItem.reject(new Error(`${message.data?.code || 'ws_error'} ${message.data?.detail || ''}`.trim()));
      } else {
        pendingItem.resolve(message);
      }
      return;
    }

    for (const listener of listeners) {
      listener(message);
    }
  });

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);

  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket_failed_to_open')), { once: true });
    }),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(event, data = {}, timeoutMs = 8000) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('socket_not_open');
      }
      const requestId = `req_${Date.now()}_${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`timeout waiting for ${event}`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ event, data, requestId }));
      });
    },
    close() {
      ws.close();
    },
  };
}

function SvgIcon({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function IconMic({ muted = false }) {
  return (
    <SvgIcon>
      <path d="M12 4a2 2 0 0 1 2 2v5a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 11a5 5 0 0 0 10 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 16v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9 20h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {muted ? <path d="M5 5l14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : null}
    </SvgIcon>
  );
}

function IconVideo({ muted = false }) {
  return (
    <SvgIcon>
      <rect x="3" y="7" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 10l5-3v10l-5-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      {muted ? <path d="M4 5l16 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : null}
    </SvgIcon>
  );
}

function IconSwitchCamera() {
  return (
    <SvgIcon>
      <path d="M8 6h8l2 3h2v8H4V9h2l2-3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 12h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 10l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </SvgIcon>
  );
}

function IconRecord({ active = false }) {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" />
    </SvgIcon>
  );
}

function IconChat() {
  return (
    <SvgIcon>
      <path d="M5 6h14v9H9l-4 3V6Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </SvgIcon>
  );
}

function IconLeave() {
  return (
    <SvgIcon>
      <path d="M4 15c2-3 5-4 8-4s6 1 8 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 14l-2 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 14l2 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </SvgIcon>
  );
}

function VideoFrame({ stream, muted = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream || null;
  }, [stream]);

  if (!stream || muted) return null;

  return <video ref={videoRef} className="video-tile__media" autoPlay playsInline muted />;
}

function ParticipantTile({ participant, compact = false, mediaStream = null, videoMuted = false }) {
  return (
    <article className={`video-tile ${compact ? 'video-tile--compact' : ''}`}>
      <div className="video-tile__frame">
        <div className="video-tile__rings" />
        <div className="video-tile__glow" />
        <VideoFrame stream={mediaStream} muted={videoMuted} />
        {!mediaStream || videoMuted ? (
          <div className="video-tile__avatar">{initialsFromName(participant.displayName || participant.participantId)}</div>
        ) : null}
      </div>
      <div className="video-tile__label">{participant.displayName || participant.participantId || 'Guest'}</div>
    </article>
  );
}

function MessageBubble({ message }) {
  const mine = message.name === 'You';
  return (
    <div className={`chat-bubble ${mine ? 'chat-bubble--mine' : ''}`}>
      <div className="chat-bubble__meta">
        <strong>{message.name}</strong>
        <span>{message.time}</span>
      </div>
      <p>{message.text}</p>
    </div>
  );
}

function InviteModal({
  open,
  customerId,
  setCustomerId,
  channel,
  setChannel,
  result,
  inviteLink,
  copied,
  onCopyLink,
  onClose,
  onSend,
}) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="invite-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-card__head">
          <div>
            <p className="eyebrow">Invite customer</p>
            <h3 id="invite-title">Short invite modal</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close invite modal">
            ×
          </button>
        </div>

        {inviteLink ? (
          <>
            <label>
              Invite link
              <div className="modal-card__copy-row">
                <input value={inviteLink} readOnly />
                <button type="button" className="primary-button" onClick={onCopyLink}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </label>

            {result ? <p className="modal-card__result">{result}</p> : null}

            <div className="modal-card__actions">
              <button type="button" className="ghost-button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              Customer ID
              <input value={customerId} onChange={(event) => setCustomerId(event.target.value)} placeholder="customer-1" />
            </label>
            <label>
              Channel
              <input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="link" />
            </label>

            {result ? <p className="modal-card__result">{result}</p> : null}

            <div className="modal-card__actions">
              <button type="button" className="ghost-button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={onSend}>
                Send invite
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LandingScreen({
  backendUrl,
  setBackendUrl,
  apiKey,
  setApiKey,
  roomName,
  setRoomName,
  participantName,
  setParticipantName,
  participantId,
  setParticipantId,
  role,
  setRole,
  otpCode,
  setOtpCode,
  joinStatus,
  joinError,
  onJoin,
  onCreate,
}) {
  return (
    <div className="landing-shell">
      <section className="landing-card">
        <div className="landing-card__header">
          <div>
            <p className="eyebrow">Start here</p>
            <h2>Join or create a room</h2>
          </div>
          <span className="status-pill status-pill--soft">{joinStatus}</span>
        </div>

        <div className="form-grid">
          <label>
            Backend URL
            <input value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder="http://localhost:9000" />
          </label>
          <label>
            API key
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="optional" />
          </label>
          <label>
            Room name
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="room-name" />
          </label>
          <label>
            Display name
            <input value={participantName} onChange={(event) => setParticipantName(event.target.value)} />
          </label>
          <label>
            Participant ID
            <input value={participantId} onChange={(event) => setParticipantId(event.target.value)} />
          </label>
          <label>
            Role
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="agent">agent</option>
              <option value="customer">customer</option>
            </select>
          </label>
          {role === 'customer' ? (
            <label>
              OTP code
              <input value={otpCode} onChange={(event) => setOtpCode(event.target.value)} placeholder="123456" />
            </label>
          ) : null}
        </div>

        {joinError ? <p className="field-error">{joinError}</p> : null}

        <div className="landing-card__actions">
          <button type="button" className="ghost-button ghost-button--wide" onClick={() => onJoin('join')}>
            Join room
          </button>
          <button type="button" className="primary-button primary-button--wide" onClick={() => onCreate('create')}>
            Create room
          </button>
        </div>
      </section>
    </div>
  );
}

function MeetingScreen({
  roomName,
  sessionInfo,
  connectionState,
  messages,
  chatDraft,
  setChatDraft,
  onSendMessage,
  participants,
  selfParticipant,
  localStream,
  audioMuted,
  videoMuted,
  cameraFacing,
  recordingActive,
  onToggleAudio,
  onToggleVideo,
  onSwitchCamera,
  onToggleRecording,
  onLeave,
  onOpenInvite,
  mobileChatOpen,
  onToggleMobileChat,
}) {
  const selfParticipantId = selfParticipant.participantId;
  const otherParticipants = participants.filter((participant) => participant.participantId !== selfParticipant.participantId);
  const hasRemoteParticipants = otherParticipants.length > 0;
  const primaryParticipant = hasRemoteParticipants ? otherParticipants[0] : selfParticipant;
  const extraParticipants = hasRemoteParticipants ? otherParticipants.slice(1) : [];

  return (
    <div className="meeting-shell">
      <header className="meeting-topbar">
        <div>
          <p className="eyebrow">Meeting</p>
          <h1>{sessionInfo?.roomName || roomName}</h1>
        </div>

        <div className="meeting-topbar__actions">
          <span className="status-pill status-pill--soft">{connectionState}</span>
          <button type="button" className="ghost-button" onClick={onOpenInvite}>
            Invite customer
          </button>
        </div>
      </header>

      <main className={`meeting-grid ${mobileChatOpen ? 'meeting-grid--chat-open' : ''}`}>
        <aside className="chat-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Chat</p>
              <h2>Conversation</h2>
            </div>
          </div>

          <div className="chat-thread">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <p>No messages yet.</p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble key={`${message.name}-${message.time}-${message.text.slice(0, 12)}`} message={message} />
              ))
            )}
          </div>

          <label className="chat-composer">
            <span>Message the room</span>
            <div className="chat-composer__row">
              <input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder="Type a message" />
              <button type="button" className="primary-button" onClick={onSendMessage}>
                Send
              </button>
            </div>
          </label>
        </aside>

        <section className="stage-panel">
          <div className="stage-headline" />

          <div className="video-layout video-layout--solo">
            <div className="video-layout__main">
              <ParticipantTile
                participant={primaryParticipant}
                mediaStream={primaryParticipant.participantId === selfParticipantId ? localStream : null}
                videoMuted={primaryParticipant.participantId === selfParticipantId ? videoMuted : false}
              />
              {hasRemoteParticipants ? (
                <div className="video-layout__pip">
                  <ParticipantTile participant={selfParticipant} compact mediaStream={localStream} videoMuted={videoMuted} />
                </div>
              ) : null}
            </div>
            {extraParticipants.length > 0 ? (
              <div className="video-layout__strip">
                {extraParticipants.map((participant) => (
                  <ParticipantTile key={participant.participantId} participant={participant} compact />
                ))}
              </div>
            ) : null}
          </div>

          <div className="control-dock" aria-label="Meeting controls">
            <button
              type="button"
              className={`control-button ${audioMuted ? 'control-button--active' : ''}`}
              onClick={onToggleAudio}
              aria-label={audioMuted ? 'Unmute audio' : 'Mute audio'}
              title={audioMuted ? 'Unmute audio' : 'Mute audio'}
              data-tooltip={audioMuted ? 'Unmute audio' : 'Mute audio'}
            >
              <IconMic muted={audioMuted} />
            </button>

            <button
              type="button"
              className={`control-button ${videoMuted ? 'control-button--active' : ''}`}
              onClick={onToggleVideo}
              aria-label={videoMuted ? 'Turn video on' : 'Turn video off'}
              title={videoMuted ? 'Turn video on' : 'Turn video off'}
              data-tooltip={videoMuted ? 'Turn video on' : 'Turn video off'}
            >
              <IconVideo muted={videoMuted} />
            </button>

            <button
              type="button"
              className="control-button"
              onClick={onSwitchCamera}
              aria-label={`Switch camera (${cameraFacing})`}
              title={`Switch camera (${cameraFacing})`}
              data-tooltip={`Switch camera (${cameraFacing})`}
            >
              <IconSwitchCamera />
            </button>

            <button
              type="button"
              className={`control-button ${recordingActive ? 'control-button--active' : ''}`}
              onClick={onToggleRecording}
              aria-label={recordingActive ? 'Stop recording' : 'Start recording'}
              title={recordingActive ? 'Stop recording' : 'Start recording'}
              data-tooltip={recordingActive ? 'Stop recording' : 'Start recording'}
            >
              <IconRecord active={recordingActive} />
            </button>

            <button
              type="button"
              className={`control-button control-button--chat ${mobileChatOpen ? 'control-button--active' : ''}`}
              onClick={onToggleMobileChat}
              aria-label={mobileChatOpen ? 'Hide chat' : 'Show chat'}
              title={mobileChatOpen ? 'Hide chat' : 'Show chat'}
              data-tooltip={mobileChatOpen ? 'Hide chat' : 'Show chat'}
            >
              <IconChat />
            </button>

            <button
              type="button"
              className="control-button control-button--leave"
              onClick={onLeave}
              aria-label="Leave meeting"
              title="Leave meeting"
              data-tooltip="Leave meeting"
            >
              <IconLeave />
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState('landing');
  const [backendUrl, setBackendUrl] = useState(normalizeBackendUrl(import.meta.env.VITE_BACKEND_URL));
  const [apiKey, setApiKey] = useState(String(import.meta.env.VITE_API_KEY || ''));
  const [roomName, setRoomName] = useState('');
  const [participantName, setParticipantName] = useState('');
  const [participantId, setParticipantId] = useState('');
  const [role, setRole] = useState('agent');
  const [otpCode, setOtpCode] = useState('');
  const [joinStatus, setJoinStatus] = useState('Ready');
  const [joinError, setJoinError] = useState('');
  const [connectionState, setConnectionState] = useState('Disconnected');
  const [connected, setConnected] = useState(false);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState(initialMessages);
  const [chatDraft, setChatDraft] = useState('');
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [cameraFacing, setCameraFacing] = useState('front');
  const [recordingActive, setRecordingActive] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCustomerId, setInviteCustomerId] = useState('customer-1');
  const [inviteChannel, setInviteChannel] = useState('link');
  const [inviteResult, setInviteResult] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteCopied, setInviteCopied] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const socketRef = useRef(null);

  function stopLocalMedia() {
    setLocalStream((current) => {
      if (current) {
        current.getTracks().forEach((track) => track.stop());
      }
      return null;
    });
  }

  async function startLocalMedia(facing = cameraFacing) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: facing === 'rear' ? 'environment' : 'user' },
    });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !audioMuted;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = !videoMuted;
    });
    setLocalStream((current) => {
      if (current) {
        current.getTracks().forEach((track) => track.stop());
      }
      return stream;
    });
    return stream;
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('sessionId');
    const inviteParticipantId = params.get('participantId');
    if (sessionId) {
      setRoomName(sessionId);
      setRole('customer');
      if (inviteParticipantId) {
        setParticipantId(inviteParticipantId);
        setInviteCustomerId(inviteParticipantId);
      }
      setJoinStatus(`Invite link detected for ${sessionId}`);
    }
  }, []);

  useEffect(
    () => () => {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      stopLocalMedia();
    },
    [],
  );

  useEffect(() => {
    if (!connected || !sessionInfo?.sessionId) return undefined;
    const timer = window.setInterval(() => {
      void refreshParticipants(sessionInfo.sessionId).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [connected, sessionInfo?.sessionId]);

  const activeParticipantId = useMemo(() => slugifyParticipantId(participantId || participantName), [participantId, participantName]);

  const selfParticipant = useMemo(
    () =>
      participants.find((participant) => participant.participantId === activeParticipantId) || {
        participantId: activeParticipantId,
        displayName: participantName,
        role,
        state: connected ? 'connected' : 'waiting',
        joinedAt: null,
      },
    [participants, activeParticipantId, participantName, role, connected],
  );

  async function refreshParticipants(sessionId) {
    const response = await requestJson(backendUrl, `/v1/sessions/${sessionId}/participants`, { apiKey });
    setParticipants(
      (response.participants || []).map((participant, index) => ({
        ...participant,
        tint: index % 3 === 0 ? 'amber' : index % 3 === 1 ? 'cream' : 'ink',
      })),
    );
  }

  function resetMeetingState() {
    setConnected(false);
    setConnectionState('Disconnected');
    setSessionInfo(null);
    setParticipants([]);
    setScreen('landing');
    setJoinStatus('Ready');
    setInviteOpen(false);
    setInviteLink('');
    setInviteCopied(false);
    setMobileChatOpen(false);
    stopLocalMedia();
  }

  async function resolveRoom(room) {
    const trimmedRoomName = String(room || '').trim();
    if (!trimmedRoomName) {
      throw new Error('room_name_required');
    }
    const resolved = await requestJson(backendUrl, `/v1/sessions/resolve?roomName=${encodeURIComponent(trimmedRoomName)}`);
    return resolved.sessionId;
  }

  async function createRoom(room) {
    const trimmedRoomName = String(room || '').trim();
    if (!trimmedRoomName) {
      throw new Error('room_name_required');
    }
    const created = await requestJson(backendUrl, '/v1/sessions', {
      method: 'POST',
      body: {
        externalRef: trimmedRoomName,
        metadata: {
          roomName: trimmedRoomName,
          displayName: participantName,
        },
      },
    });
    return created.sessionId;
  }

  async function issueJoinToken(sessionId, joinedParticipantId, joinedRole) {
    if (joinedRole === 'customer') {
      await requestJson(backendUrl, `/v1/sessions/${sessionId}/customer-verify-otp`, {
        method: 'POST',
        body: {
          participantId: joinedParticipantId,
          otp: otpCode,
        },
      });
    }

    return requestJson(backendUrl, `/v1/sessions/${sessionId}/join-token`, {
      method: 'POST',
      body: {
        participantId: joinedParticipantId,
        role: joinedRole,
        displayName: participantName,
      },
      apiKey,
    });
  }

  async function connectMeeting(joinToken, sessionId, joinedParticipantId, joinedRole, joinedRoomName) {
    if (socketRef.current) {
      socketRef.current.close();
    }

    const client = createSocketClient(joinToken.wsUrl || buildWsUrl(backendUrl));
    socketRef.current = client;

    client.onMessage((message) => {
      if (message.event === 'chatMessage') {
        const item = message.data || {};
        setMessages((current) => [
          ...current,
          {
            name: item.participantId === joinedParticipantId ? 'You' : item.participantId || 'Guest',
            text: item.text || '',
            time: new Date(item.sentAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    });

    await client.ready;
    setConnectionState('Connecting');
    await client.request('join', {
      token: joinToken.token,
      rtpCapabilities: null,
    });

    setSessionInfo({
      sessionId,
      roomName: joinedRoomName,
      role: joinedRole,
      participantId: joinedParticipantId,
      tokenExpiresAt: joinToken.expiresAt,
    });
    setConnected(true);
    setConnectionState('Live');
    setScreen('meeting');
    await startLocalMedia(cameraFacing);
    setJoinStatus(`Joined ${sessionId}`);
    await refreshParticipants(sessionId).catch(() => setParticipants([]));
  }

  async function handleJoin(mode) {
    try {
      setJoinError('');
      const trimmedRoomName = String(roomName || '').trim();
      const joinedParticipantId = slugifyParticipantId(participantId || participantName);
      setParticipantId(joinedParticipantId);
      setJoinStatus(mode === 'create' ? 'Creating room...' : 'Joining room...');

      const sessionId = mode === 'create' ? await createRoom(trimmedRoomName) : await resolveRoom(trimmedRoomName);
      const joinToken = await issueJoinToken(sessionId, joinedParticipantId, role);
      await connectMeeting(joinToken, sessionId, joinedParticipantId, role, trimmedRoomName);
    } catch (error) {
      setJoinError(error.message || 'failed_to_join');
      setJoinStatus('Ready');
      setConnectionState('Error');
    }
  }

  async function sendChatMessage() {
    const text = String(chatDraft || '').trim();
    if (!text || !socketRef.current) return;

    try {
      await socketRef.current.request('chatSend', { text });
      setChatDraft('');
    } catch (error) {
      setJoinError(error.message || 'chat_failed');
    }
  }

  async function toggleAudio() {
    if (!socketRef.current || !sessionInfo?.sessionId || !localStream) return;
    const nextMuted = !audioMuted;
    setAudioMuted(nextMuted);
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    try {
      await socketRef.current.request('deviceChanged', {
        device: `audio:${nextMuted ? 'muted' : 'live'}`,
      });
    } catch (error) {
      setJoinError(error.message || 'audio_toggle_failed');
    }
  }

  async function toggleVideo() {
    if (!socketRef.current || !sessionInfo?.sessionId || !localStream) return;
    const nextMuted = !videoMuted;
    setVideoMuted(nextMuted);
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    try {
      await socketRef.current.request('deviceChanged', {
        device: `video:${nextMuted ? 'off' : 'on'}`,
      });
    } catch (error) {
      setJoinError(error.message || 'video_toggle_failed');
    }
  }

  async function switchCamera() {
    if (!socketRef.current || !sessionInfo?.sessionId) return;
    const nextFacing = cameraFacing === 'front' ? 'rear' : 'front';
    setCameraFacing(nextFacing);
    try {
      await startLocalMedia(nextFacing);
    } catch (error) {
      setJoinError(error.message || 'camera_switch_failed');
      return;
    }
    try {
      await socketRef.current.request('deviceChanged', {
        device: `camera:${nextFacing}`,
      });
    } catch (error) {
      setJoinError(error.message || 'camera_switch_failed');
    }
  }

  async function toggleRecording() {
    if (!sessionInfo?.sessionId) return;
    try {
      if (!recordingActive) {
        const response = await requestJson(backendUrl, `/v1/sessions/${sessionInfo.sessionId}/recording/start`, {
          method: 'POST',
          body: { initiatedBy: sessionInfo.participantId || activeParticipantId },
          apiKey,
        });
        setRecordingActive(response.recording?.state === 'recording');
      } else {
        const response = await requestJson(backendUrl, `/v1/sessions/${sessionInfo.sessionId}/recording/stop`, {
          method: 'POST',
          body: { stoppedBy: sessionInfo.participantId || activeParticipantId },
          apiKey,
        });
        setRecordingActive(response.recording?.state === 'recording');
      }
    } catch (error) {
      setJoinError(error.message || 'recording_failed');
    }
  }

  async function leaveMeeting() {
    const sessionId = sessionInfo?.sessionId;
    const currentParticipantId = sessionInfo?.participantId || activeParticipantId;

    try {
      if (socketRef.current) {
        try {
          await socketRef.current.request('leave', {});
        } catch (_error) {
          // Continue with API leave even if websocket already closed.
        }
        socketRef.current.close();
        socketRef.current = null;
      }

      if (sessionId) {
        await requestJson(backendUrl, `/v1/sessions/${sessionId}/leave`, {
          method: 'POST',
          body: { participantId: currentParticipantId },
          apiKey,
        });
      }
    } finally {
      setMessages(initialMessages);
      setAudioMuted(false);
      setVideoMuted(false);
      setCameraFacing('front');
      setRecordingActive(false);
      resetMeetingState();
    }
  }

  async function sendInvite() {
    if (!sessionInfo?.sessionId) return;

    try {
      setInviteResult('');
      setInviteCopied(false);
      const response = await requestJson(backendUrl, `/v1/sessions/${sessionInfo.sessionId}/customer-invite`, {
        method: 'POST',
        body: {
          participantId: slugifyParticipantId(inviteCustomerId),
          channel: inviteChannel,
        },
        apiKey,
      });
      const fallbackLink = `${window.location.origin}${window.location.pathname}?sessionId=${encodeURIComponent(
        sessionInfo.sessionId,
      )}&participantId=${encodeURIComponent(slugifyParticipantId(inviteCustomerId))}`;
      const resolvedInviteLink =
        response?.inviteLink ||
        response?.inviteUrl ||
        response?.link ||
        response?.url ||
        response?.invite?.link ||
        response?.invite?.url ||
        fallbackLink;
      setInviteLink(resolvedInviteLink);
      setInviteResult(`Invite link ready. OTP: ${response.otp?.code || 'n/a'}`);
      setInviteOpen(true);
    } catch (error) {
      setInviteResult(error.message || 'invite_failed');
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteLink);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = inviteLink;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setInviteCopied(true);
      setInviteResult('Invite link copied to clipboard.');
    } catch (_error) {
      setInviteResult('Could not copy automatically. Please copy manually.');
    }
  }

  return screen === 'landing' ? (
    <div className="app-shell app-shell--landing">
      <LandingScreen
        backendUrl={backendUrl}
        setBackendUrl={setBackendUrl}
        apiKey={apiKey}
        setApiKey={setApiKey}
        roomName={roomName}
        setRoomName={setRoomName}
        participantName={participantName}
        setParticipantName={setParticipantName}
        participantId={participantId}
        setParticipantId={setParticipantId}
        role={role}
        setRole={setRole}
        otpCode={otpCode}
        setOtpCode={setOtpCode}
        joinStatus={joinStatus}
        joinError={joinError}
        onJoin={handleJoin}
        onCreate={handleJoin}
      />
    </div>
  ) : (
    <div className="app-shell app-shell--meeting">
      <MeetingScreen
        roomName={roomName}
        sessionInfo={sessionInfo}
        connectionState={connectionState}
        connected={connected}
        messages={messages}
        chatDraft={chatDraft}
        setChatDraft={setChatDraft}
        onSendMessage={() => void sendChatMessage()}
        participants={participants}
        selfParticipant={selfParticipant}
        localStream={localStream}
        audioMuted={audioMuted}
        videoMuted={videoMuted}
        cameraFacing={cameraFacing}
        recordingActive={recordingActive}
        onToggleAudio={() => void toggleAudio()}
        onToggleVideo={() => void toggleVideo()}
        onSwitchCamera={() => void switchCamera()}
        onToggleRecording={() => void toggleRecording()}
        onLeave={() => void leaveMeeting()}
        onOpenInvite={() => {
          setInviteResult('');
          setInviteLink('');
          setInviteCopied(false);
          setInviteOpen(true);
        }}
        mobileChatOpen={mobileChatOpen}
        onToggleMobileChat={() => setMobileChatOpen((current) => !current)}
      />

      <InviteModal
        open={inviteOpen}
        customerId={inviteCustomerId}
        setCustomerId={setInviteCustomerId}
        channel={inviteChannel}
        setChannel={setInviteChannel}
        result={inviteResult}
        inviteLink={inviteLink}
        copied={inviteCopied}
        onCopyLink={() => void copyInviteLink()}
        onClose={() => {
          setInviteOpen(false);
          setInviteCopied(false);
        }}
        onSend={() => void sendInvite()}
      />
    </div>
  );
}