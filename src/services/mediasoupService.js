const mediasoup = require("mediasoup");
const {
  mediasoupRoutersGauge,
  mediasoupTransportsGauge,
  mediasoupProducersGauge,
  mediasoupConsumersGauge,
  backendErrorsTotal
} = require("../metrics");

const MEDIA_CODECS = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 }
  }
];

class MediasoupService {
  constructor(config) {
    this.config = config;
    this.worker = null;
    this.rooms = new Map();
    this.transportIndex = new Map();
    this.producerIndex = new Map();
    this.consumerIndex = new Map();
    this.participants = new Map();
  }

  async start() {
    this.worker = await mediasoup.createWorker({
      rtcMinPort: this.config.rtcMinPort,
      rtcMaxPort: this.config.rtcMaxPort,
      logLevel: "warn",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"]
    });
    this.worker.on("died", () => {
      backendErrorsTotal.inc({ area: "mediasoup_worker_died" });
      process.exit(1);
    });
  }

  isReady() {
    return Boolean(this.worker);
  }

  getRoom(sessionId) {
    return this.rooms.get(sessionId) || null;
  }

  async ensureRoom(sessionId) {
    let room = this.rooms.get(sessionId);
    if (room) return room;

    const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    room = {
      sessionId,
      router,
      participants: new Map()
    };
    this.rooms.set(sessionId, room);
    this.updateGauges();
    return room;
  }

  async ensureParticipant(sessionId, participantId) {
    const room = await this.ensureRoom(sessionId);
    let participant = room.participants.get(participantId);
    if (!participant) {
      participant = {
        participantId,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        rtpCapabilities: null
      };
      room.participants.set(participantId, participant);
      this.participants.set(`${sessionId}:${participantId}`, participant);
    }
    return { room, participant };
  }

  async createWebRtcTransport(sessionId, participantId, direction) {
    const { room, participant } = await this.ensureParticipant(sessionId, participantId);
    const transport = await room.router.createWebRtcTransport({
      listenIps: [
        {
          ip: this.config.listenIp,
          announcedAddress: this.config.announcedAddress || undefined
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    await transport.setMaxIncomingBitrate(this.config.maxIncomingBitrate);
    participant.transports.set(transport.id, { transport, direction });
    this.transportIndex.set(transport.id, { sessionId, participantId });

    transport.on("dtlsstatechange", (state) => {
      console.log(
        `[mediasoup] dtlsstatechange transport=${transport.id} session=${sessionId} participant=${participantId} state=${state}`
      );
      if (state === "closed") {
        transport.close();
      }
    });
    transport.on("icestatechange", (state) => {
      console.log(
        `[mediasoup] icestatechange transport=${transport.id} session=${sessionId} participant=${participantId} state=${state}`
      );
    });
    transport.on("iceselectedtuplechange", (tuple) => {
      const local = tuple?.localAddress && tuple?.localPort ? `${tuple.localAddress}:${tuple.localPort}` : "n/a";
      const remote = tuple?.remoteAddress && tuple?.remotePort ? `${tuple.remoteAddress}:${tuple.remotePort}` : "n/a";
      const protocol = tuple?.protocol || "n/a";
      console.log(
        `[mediasoup] icetuple transport=${transport.id} session=${sessionId} participant=${participantId} protocol=${protocol} local=${local} remote=${remote}`
      );
    });
    transport.on("@close", () => {
      participant.transports.delete(transport.id);
      this.transportIndex.delete(transport.id);
      this.updateGauges();
    });

    this.updateGauges();
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    };
  }

  async connectTransport(sessionId, participantId, transportId, dtlsParameters) {
    const ref = this.transportIndex.get(transportId);
    if (!ref) throw new Error("transport_not_found");
    if (ref.sessionId !== sessionId || ref.participantId !== participantId) {
      throw new Error("transport_forbidden");
    }
    const participant = this.participants.get(`${ref.sessionId}:${ref.participantId}`);
    const pTransport = participant?.transports.get(transportId)?.transport;
    if (!pTransport) throw new Error("transport_not_found");
    await pTransport.connect({ dtlsParameters });
  }

  async produce(sessionId, participantId, transportId, kind, rtpParameters) {
    const ref = this.transportIndex.get(transportId);
    if (!ref || ref.sessionId !== sessionId || ref.participantId !== participantId) {
      throw new Error("transport_forbidden");
    }
    const participant = this.participants.get(`${sessionId}:${participantId}`);
    const pTransport = participant?.transports.get(transportId)?.transport;
    if (!pTransport) throw new Error("transport_not_found");
    const producer = await pTransport.produce({ kind, rtpParameters });
    participant.producers.set(producer.id, producer);
    this.producerIndex.set(producer.id, { sessionId, participantId });

    producer.on("transportclose", () => {
      participant.producers.delete(producer.id);
      this.producerIndex.delete(producer.id);
      this.updateGauges();
    });
    producer.on("@close", () => {
      participant.producers.delete(producer.id);
      this.producerIndex.delete(producer.id);
      this.updateGauges();
    });
    this.updateGauges();
    return { producerId: producer.id };
  }

  async consume(sessionId, participantId, transportId, producerId, rtpCapabilities) {
    const room = this.getRoom(sessionId);
    if (!room) throw new Error("session_not_found");
    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error("cannot_consume");
    }

    const ref = this.transportIndex.get(transportId);
    if (!ref || ref.sessionId !== sessionId || ref.participantId !== participantId) {
      throw new Error("transport_forbidden");
    }
    const participant = this.participants.get(`${sessionId}:${participantId}`);
    const pTransport = participant?.transports.get(transportId)?.transport;
    if (!pTransport) throw new Error("transport_not_found");

    const consumer = await pTransport.consume({
      producerId,
      rtpCapabilities,
      paused: false
    });

    participant.consumers.set(consumer.id, consumer);
    this.consumerIndex.set(consumer.id, { sessionId, participantId });
    consumer.on("transportclose", () => {
      participant.consumers.delete(consumer.id);
      this.consumerIndex.delete(consumer.id);
      this.updateGauges();
    });
    consumer.on("producerclose", () => {
      participant.consumers.delete(consumer.id);
      this.consumerIndex.delete(consumer.id);
      this.updateGauges();
    });
    this.updateGauges();

    return {
      consumerId: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    };
  }

  async setProducerPaused(sessionId, participantId, producerId, paused) {
    const participant = this.participants.get(`${sessionId}:${participantId}`);
    const producer = participant?.producers.get(producerId);
    if (!producer) throw new Error("producer_not_found");
    if (paused) {
      await producer.pause();
    } else {
      await producer.resume();
    }
  }

  listProducers(sessionId, excludeParticipantId) {
    const room = this.getRoom(sessionId);
    if (!room) return [];
    const all = [];
    for (const [pid, participant] of room.participants.entries()) {
      if (pid === excludeParticipantId) continue;
      for (const producer of participant.producers.values()) {
        all.push({ producerId: producer.id, kind: producer.kind, participantId: pid });
      }
    }
    return all;
  }

  getRouterRtpCapabilities(sessionId) {
    const room = this.getRoom(sessionId);
    if (!room) return null;
    return room.router.rtpCapabilities;
  }

  closeParticipant(sessionId, participantId) {
    const room = this.getRoom(sessionId);
    if (!room) return;
    const participant = room.participants.get(participantId);
    if (!participant) return;

    for (const { transport } of participant.transports.values()) {
      transport.close();
    }
    for (const producer of participant.producers.values()) {
      producer.close();
    }
    for (const consumer of participant.consumers.values()) {
      consumer.close();
    }

    room.participants.delete(participantId);
    this.participants.delete(`${sessionId}:${participantId}`);
    if (room.participants.size === 0) {
      room.router.close();
      this.rooms.delete(sessionId);
    }
    this.updateGauges();
  }

  updateGauges() {
    mediasoupRoutersGauge.set(this.rooms.size);
    mediasoupTransportsGauge.set(this.transportIndex.size);
    mediasoupProducersGauge.set(this.producerIndex.size);
    mediasoupConsumersGauge.set(this.consumerIndex.size);
  }
}

module.exports = { MediasoupService };
