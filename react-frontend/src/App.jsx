import { useEffect, useMemo, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
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

function truncateLabel(label, max = 34) {
  const s = String(label || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function createSocketClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Set();
  const closeListeners = new Set();
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
  ws.addEventListener('close', () => {
    for (const listener of closeListeners) {
      listener();
    }
  });

  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket_failed_to_open')), { once: true });
    }),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
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

function IconChevronDown() {
  return (
    <SvgIcon>
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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

function IconInfo() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1" fill="currentColor" />
    </SvgIcon>
  );
}

function IconMore() {
  return (
    <SvgIcon>
      <circle cx="6" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="18" cy="12" r="1.8" fill="currentColor" />
    </SvgIcon>
  );
}

function hasLiveVideoTrack(stream) {
  if (!stream) return false;
  return stream.getVideoTracks().some((track) => track.readyState === 'live');
}

function VideoFrame({ stream, hidden = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!videoRef.current) return undefined;
    const element = videoRef.current;
    element.srcObject = stream || null;

    if (!stream) return undefined;

    const tryPlay = () => {
      const playPromise = element.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    };

    if (element.readyState >= 1) {
      tryPlay();
    } else {
      element.onloadedmetadata = tryPlay;
    }

    return () => {
      element.onloadedmetadata = null;
    };
  }, [stream, hidden]);

  if (!stream || hidden || !hasLiveVideoTrack(stream)) return null;

  return <video ref={videoRef} className="video-tile__media" autoPlay playsInline muted />;
}

function ParticipantTile({ participant, compact = false, mediaStream = null, videoMuted = false, diagnosticsText = '' }) {
  const presenceState = participant.state === 'reconnecting' ? 'Reconnecting...' : null;
  const showVideo = Boolean(mediaStream) && !videoMuted && hasLiveVideoTrack(mediaStream);
  return (
    <article className={`video-tile ${compact ? 'video-tile--compact' : ''}`}>
      <div className="video-tile__frame">
        <div className="video-tile__rings" />
        <div className="video-tile__glow" />
        <VideoFrame stream={mediaStream} hidden={videoMuted} />
        <div className="video-tile__label">
          {participant.displayName || participant.participantId || 'Guest'}
          {presenceState ? <span className="video-tile__state"> {presenceState}</span> : null}
        </div>
        {diagnosticsText ? <div className="video-tile__metrics">{diagnosticsText}</div> : null}
        {!showVideo ? (
          <div className="video-tile__avatar">{initialsFromName(participant.displayName || participant.participantId)}</div>
        ) : null}
      </div>
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

function RemoteAudio({ stream }) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.srcObject = stream || null;
    if (stream) {
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    }
  }, [stream]);

  if (!stream || stream.getAudioTracks().length === 0) return null;
  return <audio ref={audioRef} autoPlay playsInline />;
}

function PillDeviceDropdown({ options, selectedDeviceId, disabled, placeholder, onSelect, menuAlign = 'right' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event) => {
      const node = rootRef.current;
      if (!node) return;
      if (event.target && node.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('touchstart', onDocPointerDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('touchstart', onDocPointerDown);
    };
  }, [open]);

  const hasOptions = Array.isArray(options) && options.length > 0;

  return (
    <div className={`pill-dropdown ${open ? 'pill-dropdown--open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="pill-dropdown__button"
        disabled={disabled}
        aria-label={placeholder}
        title={placeholder}
        onClick={() => {
          if (disabled) return;
          setOpen((v) => !v);
        }}
      >
        <IconChevronDown />
      </button>

      {open ? (
        <div
          className={`pill-dropdown__menu ${menuAlign === 'left' ? 'pill-dropdown__menu--left' : 'pill-dropdown__menu--right'}`}
          role="menu"
          aria-label={placeholder}
        >
          {hasOptions ? (
            options.map((opt) => {
              const label = opt.label || opt.kindLabel || `Device (${String(opt.deviceId).slice(0, 6)})`;
              const active = opt.deviceId === selectedDeviceId;
              return (
                <button
                  type="button"
                  key={opt.deviceId}
                  className={`pill-dropdown__item ${active ? 'pill-dropdown__item--active' : ''}`}
                  onClick={() => {
                    onSelect(opt.deviceId);
                    setOpen(false);
                  }}
                  role="menuitem"
                >
                  <span className="pill-dropdown__item-text">{truncateLabel(label)}</span>
                  {active ? <span className="pill-dropdown__check">✓</span> : null}
                </button>
              );
            })
          ) : (
            <div className="pill-dropdown__empty">No devices</div>
          )}
        </div>
      ) : null}
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

function DevicePickerModal({
  open,
  cameras,
  mics,
  cameraIndex,
  micIndex,
  busy,
  onClose,
  onSelectCamera,
  onSelectMicrophone,
}) {
  if (!open) return null;

  const selectedCameraId = cameras?.[cameraIndex]?.deviceId || '';
  const selectedMicId = mics?.[micIndex]?.deviceId || '';

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-card__head">
          <div>
            <p className="eyebrow">Audio & video</p>
            <h3 id="device-picker-title">Select camera and microphone</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close device picker modal">
            ×
          </button>
        </div>

        <div className="form-grid">
          <label>
            Camera
            <select
              value={selectedCameraId}
              disabled={busy || !cameras || cameras.length === 0}
              onChange={(event) => onSelectCamera(event.target.value)}
            >
              {cameras && cameras.length > 0 ? (
                cameras.map((camera) => (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label || `Camera (${String(camera.deviceId).slice(0, 6)})`}
                  </option>
                ))
              ) : (
                <option value="" disabled>
                  No cameras found
                </option>
              )}
            </select>
          </label>

          <label>
            Microphone
            <select
              value={selectedMicId}
              disabled={busy || !mics || mics.length === 0}
              onChange={(event) => onSelectMicrophone(event.target.value)}
            >
              {mics && mics.length > 0 ? (
                mics.map((mic) => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label || `Microphone (${String(mic.deviceId).slice(0, 6)})`}
                  </option>
                ))
              ) : (
                <option value="" disabled>
                  No microphones found
                </option>
              )}
            </select>
          </label>
        </div>

        <div className="modal-card__actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
            Close
          </button>
          {busy ? <span className="tiny-note">Updating devices...</span> : null}
        </div>
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
  joinError,
  reconnecting,
  messages,
  chatDraft,
  setChatDraft,
  onSendMessage,
  participants,
  selfParticipant,
  localStream,
  participantStreams,
  mediaStats,
  audioMuted,
  videoMuted,
  availableCameras,
  availableMics,
  cameraIndex,
  micIndex,
  recordingActive,
  recordingBusy,
  deviceBusy,
  onToggleAudio,
  onToggleVideo,
  onSelectCameraDevice,
  onSelectMicrophoneDevice,
  onToggleRecording,
  onLeave,
  onOpenInvite,
  mobileChatOpen,
  onToggleMobileChat,
}) {
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const selfParticipantId = selfParticipant.participantId;
  const otherParticipants = participants.filter((participant) => participant.participantId !== selfParticipant.participantId);
  const hasRemoteParticipants = otherParticipants.length > 0;
  const primaryParticipant = hasRemoteParticipants ? otherParticipants[0] : selfParticipant;
  const extraParticipants = hasRemoteParticipants ? otherParticipants.slice(1) : [];
  const streamForParticipant = (participant) =>
    participant.participantId === selfParticipantId ? localStream : participantStreams[participant.participantId] || null;
  const remoteAudioStreams = Object.entries(participantStreams)
    .filter(([participantId, stream]) => participantId !== selfParticipantId && stream.getAudioTracks().length > 0)
    .map(([participantId, stream]) => ({ participantId, stream }));

  const showErrorStatus = !reconnecting && Boolean(joinError || /error|failed|disconnect/i.test(connectionState));
  const errorText = joinError || connectionState || 'Connection error';
  const diagnosticsText = mediaStats
    ? `Send: ${mediaStats.resolution || 'n/a'} @ ${mediaStats.fps ?? 'n/a'}fps, ${mediaStats.bitrateKbps ?? 'n/a'} kbps${
        mediaStats.rttMs != null ? `, RTT ${mediaStats.rttMs}ms` : ''
      }, loss ${mediaStats.lossPct ?? 'n/a'}%`
    : '';

  const selectedCameraDeviceId = availableCameras?.[cameraIndex]?.deviceId || '';
  const selectedMicDeviceId = availableMics?.[micIndex]?.deviceId || '';

  return (
    <div className="meeting-shell">
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
                mediaStream={streamForParticipant(primaryParticipant)}
                videoMuted={primaryParticipant.participantId === selfParticipantId ? videoMuted : false}
                diagnosticsText={primaryParticipant.participantId === selfParticipantId ? diagnosticsText : ''}
              />
              {hasRemoteParticipants ? (
                <div className="video-layout__pip">
                  <ParticipantTile participant={selfParticipant} compact mediaStream={localStream} videoMuted={videoMuted} diagnosticsText={diagnosticsText} />
                </div>
              ) : null}
            </div>
            {extraParticipants.length > 0 ? (
              <div className="video-layout__strip">
                {extraParticipants.map((participant) => (
                  <ParticipantTile key={participant.participantId} participant={participant} compact mediaStream={streamForParticipant(participant)} />
                ))}
              </div>
            ) : null}
          </div>

          <div className="meeting-footer">
            <div className="meeting-footer__status">
              {reconnecting ? <span className="reconnect-banner">Reconnecting...</span> : null}
              {showErrorStatus ? <span className="reconnect-banner reconnect-banner--error">{errorText}</span> : null}
            </div>
            <div className="control-dock" aria-label="Meeting controls">
              <div className={`split-toggle ${audioMuted ? 'split-toggle--active' : ''}`}>
                <button
                  type="button"
                  className="split-toggle__toggle"
                  onClick={onToggleAudio}
                  disabled={reconnecting || deviceBusy}
                  aria-label={audioMuted ? 'Unmute audio' : 'Mute audio'}
                  title={audioMuted ? 'Unmute audio' : 'Mute audio'}
                >
                  <IconMic muted={audioMuted} />
                </button>
                <PillDeviceDropdown
                  options={availableMics || []}
                  selectedDeviceId={selectedMicDeviceId}
                  disabled={reconnecting || deviceBusy || !availableMics || availableMics.length === 0}
                  placeholder="Select microphone"
                  onSelect={(deviceId) => onSelectMicrophoneDevice(deviceId)}
                  menuAlign="left"
                />
              </div>

              <div className={`split-toggle ${videoMuted ? 'split-toggle--active' : ''}`}>
                <button
                  type="button"
                  className="split-toggle__toggle"
                  onClick={onToggleVideo}
                  disabled={reconnecting || deviceBusy}
                  aria-label={videoMuted ? 'Turn video on' : 'Turn video off'}
                  title={videoMuted ? 'Turn video on' : 'Turn video off'}
                >
                  <IconVideo muted={videoMuted} />
                </button>
                <PillDeviceDropdown
                  options={availableCameras || []}
                  selectedDeviceId={selectedCameraDeviceId}
                  disabled={reconnecting || deviceBusy || !availableCameras || availableCameras.length === 0}
                  placeholder="Select camera"
                  onSelect={(deviceId) => onSelectCameraDevice(deviceId)}
                />
              </div>

              <button
                type="button"
                className={`control-button control-button--secondary ${recordingActive ? 'control-button--active' : ''}`}
                onClick={onToggleRecording}
                disabled={reconnecting || recordingBusy}
                aria-label={recordingActive ? 'Stop recording' : 'Start recording'}
                title={recordingActive ? 'Stop recording' : 'Start recording'}
                data-tooltip={recordingActive ? 'Stop recording' : 'Start recording'}
              >
                <IconRecord active={recordingActive} />
              </button>

              <button
                type="button"
                className={`control-button control-button--chat control-button--secondary ${mobileChatOpen ? 'control-button--active' : ''}`}
                onClick={onToggleMobileChat}
                disabled={reconnecting}
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
                disabled={reconnecting}
                aria-label="Leave meeting"
                title="Leave meeting"
                data-tooltip="Leave meeting"
              >
                <IconLeave />
              </button>

              <button
                type="button"
                className={`control-button control-button--more ${mobileControlsOpen ? 'control-button--active' : ''}`}
                onClick={() => setMobileControlsOpen((open) => !open)}
                disabled={reconnecting}
                aria-label={mobileControlsOpen ? 'Hide more actions' : 'Show more actions'}
                title={mobileControlsOpen ? 'Hide more actions' : 'Show more actions'}
                data-tooltip={mobileControlsOpen ? 'Hide more actions' : 'More actions'}
              >
                <IconMore />
              </button>
            </div>
            <button
              type="button"
              className="control-button control-button--info control-button--secondary"
              onClick={onOpenInvite}
              aria-label={`Meeting info for ${sessionInfo?.roomName || roomName}`}
              title={`Meeting info for ${sessionInfo?.roomName || roomName}`}
              data-tooltip="Meeting info"
            >
              <IconInfo />
            </button>
          </div>
          {mobileControlsOpen ? (
            <div className="mobile-controls-menu">
              <button type="button" className="ghost-button" onClick={onToggleRecording} disabled={reconnecting || recordingBusy}>
                {recordingActive ? 'Stop recording' : 'Start recording'}
              </button>
              <button type="button" className="ghost-button" onClick={onToggleMobileChat} disabled={reconnecting}>
                {mobileChatOpen ? 'Hide chat' : 'Show chat'}
              </button>
              <button type="button" className="ghost-button" onClick={onOpenInvite}>
                Meeting info
              </button>
            </div>
          ) : null}
        </section>
      </main>
      {remoteAudioStreams.map(({ participantId, stream }) => (
        <RemoteAudio key={participantId} stream={stream} />
      ))}
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
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCustomerId, setInviteCustomerId] = useState('customer-1');
  const [inviteChannel, setInviteChannel] = useState('link');
  const [inviteResult, setInviteResult] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteCopied, setInviteCopied] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [participantStreams, setParticipantStreams] = useState({});
  const [mediaStats, setMediaStats] = useState(null);
  const [cameraIndex, setCameraIndex] = useState(0);
  const availableCamerasRef = useRef([]);
  const [availableCameras, setAvailableCameras] = useState([]);
  const cameraIndexRef = useRef(0);
  const selectedCameraDeviceIdRef = useRef('');
  const [micIndex, setMicIndex] = useState(0);
  const availableMicsRef = useRef([]);
  const [availableMics, setAvailableMics] = useState([]);
  const micIndexRef = useRef(0);
  const selectedMicDeviceIdRef = useRef('');
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [devicePickerBusy, setDevicePickerBusy] = useState(false);
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const audioProducerRef = useRef(null);
  const videoProducerRef = useRef(null);
  const consumersByProducerRef = useRef(new Map());
  const consumePollTimerRef = useRef(null);
  const qualityReportTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectingRef = useRef(false);
  const intentionalLeaveRef = useRef(false);
  const connectionMetaRef = useRef(null);
  const localStreamRef = useRef(null);
  const lastVideoOutboundRef = useRef({ bytesSent: null, timestampMs: null });

  function updateLocalStream(nextStream) {
    localStreamRef.current = nextStream;
    setLocalStream(nextStream);
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function clearMediaTransportState() {
    if (consumePollTimerRef.current) {
      window.clearInterval(consumePollTimerRef.current);
      consumePollTimerRef.current = null;
    }
    if (qualityReportTimerRef.current) {
      window.clearInterval(qualityReportTimerRef.current);
      qualityReportTimerRef.current = null;
    }
    consumersByProducerRef.current.forEach(({ consumer }) => {
      try {
        consumer.close();
      } catch (_error) {
        // Ignore cleanup errors.
      }
    });
    consumersByProducerRef.current.clear();
    if (sendTransportRef.current) {
      try {
        sendTransportRef.current.close();
      } catch (_error) {
        // Ignore cleanup errors.
      }
      sendTransportRef.current = null;
    }
    if (recvTransportRef.current) {
      try {
        recvTransportRef.current.close();
      } catch (_error) {
        // Ignore cleanup errors.
      }
      recvTransportRef.current = null;
    }
    audioProducerRef.current = null;
    videoProducerRef.current = null;
    deviceRef.current = null;
    lastVideoOutboundRef.current = { bytesSent: null, timestampMs: null };
    setMediaStats(null);
    setParticipantStreams({});
  }

  function stopLocalMedia() {
    const current = localStreamRef.current;
    if (current) {
      current.getTracks().forEach((track) => track.stop());
    }
    updateLocalStream(null);
  }

  async function refreshVideoDevices(stream = localStream) {
    const devices = await navigator.mediaDevices.enumerateDevices();

    const camerasFull = devices.filter((device) => device.kind === 'videoinput');
    const cameras = camerasFull;

    availableCamerasRef.current = cameras;
    setAvailableCameras(cameras);
    const currentTrack = stream?.getVideoTracks?.()[0];
    const currentDeviceId = currentTrack?.getSettings?.().deviceId;

    let resolvedIdx = 0;
    if (currentDeviceId) {
      const idx = cameras.findIndex((camera) => camera.deviceId === currentDeviceId);
      resolvedIdx = idx >= 0 ? idx : 0;
    } else {
      const selectedDeviceId = selectedCameraDeviceIdRef.current;
      if (selectedDeviceId) {
        const idx = cameras.findIndex((camera) => camera.deviceId === selectedDeviceId);
        resolvedIdx = idx >= 0 ? idx : resolvedIdx;
      }
      if (cameras.length > 0 && resolvedIdx === 0 && cameraIndexRef.current >= 0 && cameraIndexRef.current < cameras.length) {
        resolvedIdx = cameraIndexRef.current;
      }
    }

    cameraIndexRef.current = resolvedIdx;
    selectedCameraDeviceIdRef.current = cameras?.[resolvedIdx]?.deviceId || '';
    setCameraIndex(resolvedIdx);
    return cameras;
  }

  async function refreshAudioDevices(stream = localStream) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((device) => device.kind === 'audioinput');
    availableMicsRef.current = mics;
    setAvailableMics(mics);
    const currentTrack = stream?.getAudioTracks?.()[0];
    const currentDeviceId = currentTrack?.getSettings?.().deviceId;

    let resolvedIdx = 0;
    if (currentDeviceId) {
      const idx = mics.findIndex((mic) => mic.deviceId === currentDeviceId);
      resolvedIdx = idx >= 0 ? idx : 0;
    } else {
      const selectedDeviceId = selectedMicDeviceIdRef.current;
      if (selectedDeviceId) {
        const idx = mics.findIndex((mic) => mic.deviceId === selectedDeviceId);
        resolvedIdx = idx >= 0 ? idx : resolvedIdx;
      }
      if (mics.length > 0 && resolvedIdx === 0 && micIndexRef.current >= 0 && micIndexRef.current < mics.length) {
        resolvedIdx = micIndexRef.current;
      }
    }

    micIndexRef.current = resolvedIdx;
    selectedMicDeviceIdRef.current = mics?.[resolvedIdx]?.deviceId || '';
    setMicIndex(resolvedIdx);
    return mics;
  }

  async function startLocalMedia(facing = cameraFacing) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: facing === 'rear' ? 'environment' : 'user' },
      });
      setVideoMuted(false);
      setAudioMuted(false);
    } catch (_error) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      setVideoMuted(true);
      setJoinError('Camera unavailable, joined with audio only.');
    }
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !audioMuted;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = !videoMuted;
    });
    const current = localStreamRef.current;
    if (current) {
      current.getTracks().forEach((track) => track.stop());
    }
    updateLocalStream(stream);
    await refreshVideoDevices(stream).catch(() => {});
    await refreshAudioDevices(stream).catch(() => {});
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
      clearReconnectTimer();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      clearMediaTransportState();
      stopLocalMedia();
    },
    [],
  );

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
    intentionalLeaveRef.current = false;
    reconnectingRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    clearMediaTransportState();
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

  function attachConsumerTrack(participantKey, producerId, track, consumer) {
    setParticipantStreams((current) => {
      const next = { ...current };
      const existingStream = next[participantKey];
      const existingTracks = existingStream ? existingStream.getTracks() : [];
      const dedupedTracks = existingTracks.filter((item) => item.id !== track.id);
      next[participantKey] = new MediaStream([...dedupedTracks, track]);
      return next;
    });
    consumersByProducerRef.current.set(producerId, { participantId: participantKey, consumer, track });
  }

  function detachConsumerTrack(producerId) {
    const linked = consumersByProducerRef.current.get(producerId);
    if (!linked) return;
    setParticipantStreams((current) => {
      const stream = current[linked.participantId];
      if (!stream) return current;
      const next = { ...current };
      const remainingTracks = stream.getTracks().filter((track) => track.id !== linked.track.id);
      if (remainingTracks.length === 0) {
        delete next[linked.participantId];
      } else {
        next[linked.participantId] = new MediaStream(remainingTracks);
      }
      return next;
    });
    try {
      linked.consumer.close();
    } catch (_error) {
      // Ignore cleanup errors.
    }
    consumersByProducerRef.current.delete(producerId);
  }

  async function consumeMissingProducers(client) {
    if (!recvTransportRef.current || !deviceRef.current) return;
    const updateResp = await client.request('listProducers', {});
    const producers = updateResp?.data?.producers || [];
    const activeProducerIds = new Set(producers.map((item) => item.producerId));

    for (const producer of producers) {
      if (consumersByProducerRef.current.has(producer.producerId)) continue;
      const consumeResp = await client.request('consume', {
        transportId: recvTransportRef.current.id,
        producerId: producer.producerId,
        rtpCapabilities: deviceRef.current.rtpCapabilities,
      });
      const consumed = consumeResp.data;
      const consumer = await recvTransportRef.current.consume({
        id: consumed.consumerId,
        producerId: consumed.producerId,
        kind: consumed.kind,
        rtpParameters: consumed.rtpParameters,
      });
      attachConsumerTrack(producer.participantId, producer.producerId, consumer.track, consumer);
    }

    for (const knownProducerId of Array.from(consumersByProducerRef.current.keys())) {
      if (!activeProducerIds.has(knownProducerId)) {
        detachConsumerTrack(knownProducerId);
      }
    }
  }

  async function sendQualityReport(client) {
    if (!sendTransportRef.current) return;
    const stats = await sendTransportRef.current.getStats();
    let outboundRttMs = null;
    let inboundJitterMs = null;
    let inboundPacketLossPct = null;
    let iceConnectionState = sendTransportRef.current.connectionState || null;
    let outboundVideoBitrateKbps = null;
    let outboundVideoFps = null;
    let outboundWidth = null;
    let outboundHeight = null;
    stats.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
        if (typeof stat.currentRoundTripTime === 'number') {
          outboundRttMs = Math.round(stat.currentRoundTripTime * 1000);
        }
      }
      if (stat.type === 'inbound-rtp' && typeof stat.jitter === 'number') {
        inboundJitterMs = Math.round(stat.jitter * 1000);
        const packetsLost = Number(stat.packetsLost || 0);
        const packetsReceived = Number(stat.packetsReceived || 0);
        const totalPackets = packetsLost + packetsReceived;
        if (totalPackets > 0) {
          inboundPacketLossPct = Math.round((packetsLost / totalPackets) * 10000) / 100;
        }
      }
      if (stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
        const bytesSent = typeof stat.bytesSent === 'number' ? stat.bytesSent : null;
        const timestampMs = typeof stat.timestamp === 'number' ? stat.timestamp : null;
        if (bytesSent != null && timestampMs != null) {
          const previous = lastVideoOutboundRef.current;
          if (previous.bytesSent != null && previous.timestampMs != null && timestampMs > previous.timestampMs) {
            const bitsDelta = (bytesSent - previous.bytesSent) * 8;
            const secondsDelta = (timestampMs - previous.timestampMs) / 1000;
            if (secondsDelta > 0) {
              outboundVideoBitrateKbps = Math.max(0, Math.round(bitsDelta / secondsDelta / 1000));
            }
          }
          lastVideoOutboundRef.current = { bytesSent, timestampMs };
        }
        if (typeof stat.framesPerSecond === 'number') {
          outboundVideoFps = Math.round(stat.framesPerSecond);
        }
        if (typeof stat.frameWidth === 'number') {
          outboundWidth = Math.round(stat.frameWidth);
        }
        if (typeof stat.frameHeight === 'number') {
          outboundHeight = Math.round(stat.frameHeight);
        }
      }
    });

    const localVideoTrack = localStreamRef.current?.getVideoTracks?.()[0] || null;
    const localSettings = localVideoTrack?.getSettings?.() || {};
    const finalFps = outboundVideoFps ?? (typeof localSettings.frameRate === 'number' ? Math.round(localSettings.frameRate) : null);
    const finalWidth = outboundWidth ?? (typeof localSettings.width === 'number' ? Math.round(localSettings.width) : null);
    const finalHeight = outboundHeight ?? (typeof localSettings.height === 'number' ? Math.round(localSettings.height) : null);
    const resolution = finalWidth && finalHeight ? `${finalWidth}x${finalHeight}` : null;
    setMediaStats({
      bitrateKbps: outboundVideoBitrateKbps,
      fps: finalFps,
      resolution,
      rttMs: outboundRttMs,
      lossPct: inboundPacketLossPct,
    });

    await client.request(
      'qualityReport',
      {
        outboundRttMs,
        inboundJitterMs,
        inboundPacketLossPct,
        iceConnectionState,
        timestamp: new Date().toISOString(),
      },
      3000,
    );
  }

  async function setupMediaTransports(client, routerRtpCapabilities, currentStream) {
    clearMediaTransportState();
    const device = new Device();
    await device.load({ routerRtpCapabilities });
    deviceRef.current = device;

    const sendTransportResp = await client.request('createTransport', { direction: 'send' });
    const recvTransportResp = await client.request('createTransport', { direction: 'recv' });

    const sendTransport = device.createSendTransport({
      id: sendTransportResp.data.id,
      iceParameters: sendTransportResp.data.iceParameters,
      iceCandidates: sendTransportResp.data.iceCandidates,
      dtlsParameters: sendTransportResp.data.dtlsParameters,
    });
    sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await client.request('connectTransport', { transportId: sendTransport.id, dtlsParameters });
        callback();
      } catch (error) {
        errback(error);
      }
    });
    sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const response = await client.request('produce', { transportId: sendTransport.id, kind, rtpParameters });
        callback({ id: response.data.producerId });
      } catch (error) {
        errback(error);
      }
    });
    sendTransportRef.current = sendTransport;

    const recvTransport = device.createRecvTransport({
      id: recvTransportResp.data.id,
      iceParameters: recvTransportResp.data.iceParameters,
      iceCandidates: recvTransportResp.data.iceCandidates,
      dtlsParameters: recvTransportResp.data.dtlsParameters,
    });
    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await client.request('connectTransport', { transportId: recvTransport.id, dtlsParameters });
        callback();
      } catch (error) {
        errback(error);
      }
    });
    recvTransportRef.current = recvTransport;

    const audioTrack = currentStream?.getAudioTracks?.()[0];
    const videoTrack = currentStream?.getVideoTracks?.()[0];
    if (audioTrack) {
      audioProducerRef.current = await sendTransport.produce({ track: audioTrack });
    }
    if (videoTrack) {
      videoProducerRef.current = await sendTransport.produce({
        track: videoTrack,
        encodings: [
          { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150000 },
          { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500000 },
          { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1200000 },
        ],
      });
    }

    await consumeMissingProducers(client);
    consumePollTimerRef.current = window.setInterval(() => {
      void consumeMissingProducers(client).catch(() => {});
    }, 2000);
    qualityReportTimerRef.current = window.setInterval(() => {
      void sendQualityReport(client).catch(() => {});
    }, 3000);
  }

  async function connectMeeting(joinToken, sessionId, joinedParticipantId, joinedRole, joinedRoomName) {
    if (socketRef.current) {
      socketRef.current.close();
    }

    const client = createSocketClient(joinToken.wsUrl || buildWsUrl(backendUrl));
    socketRef.current = client;
    client.onClose(() => {
      if (intentionalLeaveRef.current || reconnectingRef.current) return;
      setConnectionState('Reconnecting');
      reconnectingRef.current = true;
      clearMediaTransportState();
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        void reconnectMeeting();
      }, 1500);
    });

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
        return;
      }

      if (message.event === 'participantPresence' && message.data?.sessionId === sessionId) {
        void refreshParticipants(sessionId).catch(() => {});
        void consumeMissingProducers(client).catch(() => {});
        return;
      }

      if (message.event === 'qualityAlert') {
        setJoinError(
          `Network ${message.data?.severity || 'degraded'}: RTT ${message.data?.metrics?.outboundRttMs ?? 'n/a'}ms, loss ${
            message.data?.metrics?.inboundPacketLossPct ?? 'n/a'
          }%`,
        );
      }
    });

    await client.ready;
    setConnectionState('Connecting');
    const joinResponse = await client.request('join', {
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
    reconnectAttemptRef.current = 0;
    reconnectingRef.current = false;
    setScreen('meeting');
    const liveStream = await startLocalMedia(cameraFacing);
    await setupMediaTransports(client, joinResponse.data.routerRtpCapabilities, liveStream);
    setJoinStatus(`Joined ${sessionId}`);
    await refreshParticipants(sessionId).catch(() => setParticipants([]));
  }

  async function reconnectMeeting() {
    const meta = connectionMetaRef.current;
    if (!meta) return;
    if (reconnectAttemptRef.current >= 3) {
      setJoinError('Reconnect failed after 3 attempts. Please join again.');
      resetMeetingState();
      return;
    }
    reconnectAttemptRef.current += 1;
    setConnectionState(`Reconnecting (${reconnectAttemptRef.current}/3)`);
    try {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      clearMediaTransportState();
      const joinToken = await issueJoinToken(meta.sessionId, meta.participantId, meta.role);
      await connectMeeting(joinToken, meta.sessionId, meta.participantId, meta.role, meta.roomName);
    } catch (_error) {
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        void reconnectMeeting();
      }, 1500);
    }
  }

  async function handleJoin(mode) {
    try {
      intentionalLeaveRef.current = false;
      reconnectingRef.current = false;
      reconnectAttemptRef.current = 0;
      setJoinError('');
      const trimmedRoomName = String(roomName || '').trim();
      const joinedParticipantId = slugifyParticipantId(participantId || participantName);
      setParticipantId(joinedParticipantId);
      setJoinStatus(mode === 'create' ? 'Creating room...' : 'Joining room...');

      const sessionId = mode === 'create' ? await createRoom(trimmedRoomName) : await resolveRoom(trimmedRoomName);
      connectionMetaRef.current = {
        sessionId,
        participantId: joinedParticipantId,
        role,
        roomName: trimmedRoomName,
      };
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
    const currentStream = localStreamRef.current;
    if (!socketRef.current || !sessionInfo?.sessionId || !currentStream) return;
    const track = currentStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const nextMuted = !track.enabled;
    setAudioMuted(nextMuted);
    try {
      await socketRef.current.request('deviceChanged', {
        device: `audio:${nextMuted ? 'muted' : 'live'}`,
      });
    } catch (error) {
      setJoinError(error.message || 'audio_toggle_failed');
    }
  }

  async function toggleVideo() {
    const currentStream = localStreamRef.current;
    if (!socketRef.current || !sessionInfo?.sessionId || !currentStream) return;
    const activeTrack = currentStream.getVideoTracks()[0];
    if (!videoMuted) {
      if (activeTrack) {
        currentStream.removeTrack(activeTrack);
        activeTrack.stop();
      }
      if (videoProducerRef.current) {
        try {
          videoProducerRef.current.close();
        } catch (_error) {
          // Ignore close errors.
        }
        videoProducerRef.current = null;
      }
      updateLocalStream(new MediaStream(currentStream.getTracks()));
      setVideoMuted(true);
      try {
        await socketRef.current.request('deviceChanged', {
          device: 'video:off',
        });
      } catch (error) {
        setJoinError(error.message || 'video_toggle_failed');
      }
      return;
    }

    try {
      let stream;
      const selectedCamera = availableCamerasRef.current?.[cameraIndexRef.current];
      try {
        stream = selectedCamera?.deviceId
          ? await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { deviceId: { exact: selectedCamera.deviceId } },
            })
          : await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } catch (_error1) {
        // Fallback for browsers that don't fully support exact deviceId constraints.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: cameraFacing === 'rear' ? 'environment' : 'user' },
        });
      }
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        throw new Error('video_track_missing');
      }
      videoTrack.enabled = true;
      currentStream.getVideoTracks().forEach((track) => {
        currentStream.removeTrack(track);
        track.stop();
      });
      currentStream.addTrack(videoTrack);
      // Refresh local preview immediately so camera on/off feels responsive.
      updateLocalStream(new MediaStream(currentStream.getTracks()));
      setVideoMuted(false);
      if (sendTransportRef.current) {
        videoProducerRef.current = await sendTransportRef.current.produce({
          track: videoTrack,
          encodings: [
            { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150000 },
            { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500000 },
            { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1200000 },
          ],
        });
      }
      await refreshVideoDevices(currentStream).catch(() => {});
      await socketRef.current.request('deviceChanged', {
        device: 'video:on',
      });
    } catch (error) {
      setJoinError(error.message || 'video_device_unavailable');
    }
  }

  async function openDevicePicker() {
    const currentStream = localStreamRef.current;
    if (!socketRef.current || !sessionInfo?.sessionId || !currentStream) return;
    if (devicePickerBusy) return;

    setDevicePickerBusy(true);
    try {
      await refreshVideoDevices(currentStream).catch(() => {});
      await refreshAudioDevices(currentStream).catch(() => {});
    } finally {
      setDevicePickerBusy(false);
    }

    setDevicePickerOpen(true);
  }

  async function selectCameraDevice(deviceId) {
    const currentStream = localStreamRef.current;
    if (!socketRef.current || !sessionInfo?.sessionId || !currentStream) return;
    if (!deviceId) return;

    const cameras = availableCamerasRef.current || [];
    const nextIndex = cameras.findIndex((camera) => camera.deviceId === deviceId);
    const resolvedIndex = nextIndex >= 0 ? nextIndex : 0;
    cameraIndexRef.current = resolvedIndex;
    setCameraIndex(resolvedIndex);
    selectedCameraDeviceIdRef.current = deviceId;

    // If video is currently off (producer closed), just update the selection.
    if (!videoProducerRef.current) return;

    setDevicePickerBusy(true);
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: deviceId } },
        });
      } catch (_error1) {
        // Some mobile browsers don't fully support `deviceId: { exact }`.
        // Probe both facingModes and pick the one that matches the chosen deviceId if possible.
        const tryFacingMode = async (facingMode) => {
          try {
            const probeStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode },
            });
            const [track] = probeStream.getVideoTracks();
            const probeDeviceId = track?.getSettings?.().deviceId;
            return { probeStream, probeDeviceId };
          } catch (_probeError) {
            return null;
          }
        };

        const [userProbe, envProbe] = await Promise.all([tryFacingMode('user'), tryFacingMode('environment')]);

        const chosenProbe =
          (userProbe && userProbe.probeDeviceId === deviceId && userProbe) ||
          (envProbe && envProbe.probeDeviceId === deviceId && envProbe) ||
          userProbe ||
          envProbe;

        if (!chosenProbe) {
          throw new Error('camera_switch_failed');
        }

        if (userProbe && userProbe !== chosenProbe) {
          try {
            userProbe.probeStream.getTracks().forEach((t) => t.stop());
          } catch (_stopError) {
            // Ignore cleanup errors.
          }
        }
        if (envProbe && envProbe !== chosenProbe) {
          try {
            envProbe.probeStream.getTracks().forEach((t) => t.stop());
          } catch (_stopError) {
            // Ignore cleanup errors.
          }
        }

        stream = chosenProbe.probeStream;
      }
      const [newTrack] = stream.getVideoTracks();
      if (!newTrack) throw new Error('camera_track_missing');

      newTrack.enabled = !videoMuted;
      currentStream.getVideoTracks().forEach((track) => {
        currentStream.removeTrack(track);
        track.stop();
      });
      currentStream.addTrack(newTrack);

      await videoProducerRef.current.replaceTrack({ track: newTrack });
      updateLocalStream(currentStream);
      await refreshVideoDevices(currentStream).catch(() => {});
      await socketRef.current
        .request('deviceChanged', {
          device: 'camera_switched',
        })
        .catch(() => {});
    } catch (error) {
      setJoinError(error.message || 'camera_select_failed');
    } finally {
      setDevicePickerBusy(false);
    }
  }

  async function selectMicrophoneDevice(deviceId) {
    const currentStream = localStreamRef.current;
    if (!socketRef.current || !sessionInfo?.sessionId || !currentStream) return;
    if (!deviceId) return;

    const mics = availableMicsRef.current || [];
    const nextIndex = mics.findIndex((mic) => mic.deviceId === deviceId);
    const resolvedIndex = nextIndex >= 0 ? nextIndex : 0;
    micIndexRef.current = resolvedIndex;
    setMicIndex(resolvedIndex);
    selectedMicDeviceIdRef.current = deviceId;

    if (!audioProducerRef.current) return;

    setDevicePickerBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });
      const [newTrack] = stream.getAudioTracks();
      if (!newTrack) throw new Error('audio_track_missing');

      newTrack.enabled = !audioMuted;

      currentStream.getAudioTracks().forEach((track) => {
        currentStream.removeTrack(track);
        track.stop();
      });
      currentStream.addTrack(newTrack);

      await audioProducerRef.current.replaceTrack({ track: newTrack });
      updateLocalStream(currentStream);
      await refreshAudioDevices(currentStream).catch(() => {});
      await socketRef.current
        .request('deviceChanged', {
          device: `audio:${audioMuted ? 'muted' : 'live'}`,
        })
        .catch(() => {});
    } catch (error) {
      setJoinError(error.message || 'microphone_select_failed');
    } finally {
      setDevicePickerBusy(false);
    }
  }

  async function toggleRecording() {
    if (!sessionInfo?.sessionId || recordingBusy) return;
    const wantsStart = !recordingActive;
    const initiatedBy = sessionInfo.participantId || activeParticipantId;
    setRecordingBusy(true);
    try {
      if (wantsStart) {
        const response = await requestJson(backendUrl, `/v1/sessions/${sessionInfo.sessionId}/recording/start`, {
          method: 'POST',
          body: { initiatedBy },
          apiKey,
        });
        const nextState = response?.recording?.state || response?.recording?.status || response?.state || 'recording';
        setRecordingActive(nextState === 'recording');
      } else {
        const response = await requestJson(backendUrl, `/v1/sessions/${sessionInfo.sessionId}/recording/stop`, {
          method: 'POST',
          body: { stoppedBy: initiatedBy },
          apiKey,
        });
        const nextState = response?.recording?.state || response?.recording?.status || response?.state || 'stopped';
        setRecordingActive(nextState === 'recording');
      }
    } catch (error) {
      setJoinError(error.message || 'recording_failed');
    } finally {
      setRecordingBusy(false);
    }
  }

  async function leaveMeeting() {
    const sessionId = sessionInfo?.sessionId;
    const currentParticipantId = sessionInfo?.participantId || activeParticipantId;

    try {
      intentionalLeaveRef.current = true;
      clearReconnectTimer();
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
        joinError={joinError}
        reconnecting={connectionState.startsWith('Reconnecting')}
        connected={connected}
        messages={messages}
        chatDraft={chatDraft}
        setChatDraft={setChatDraft}
        onSendMessage={() => void sendChatMessage()}
        participants={participants}
        selfParticipant={selfParticipant}
        localStream={localStream}
        participantStreams={participantStreams}
        mediaStats={mediaStats}
        audioMuted={audioMuted}
        videoMuted={videoMuted}
        availableCameras={availableCameras}
        availableMics={availableMics}
        cameraIndex={cameraIndex}
        micIndex={micIndex}
        recordingActive={recordingActive}
        recordingBusy={recordingBusy}
        deviceBusy={devicePickerBusy}
        onToggleAudio={() => void toggleAudio()}
        onToggleVideo={() => void toggleVideo()}
        onSelectCameraDevice={(deviceId) => void selectCameraDevice(deviceId)}
        onSelectMicrophoneDevice={(deviceId) => void selectMicrophoneDevice(deviceId)}
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