const { v7: uuidv7 } = require("uuid");

class EventBus {
  constructor({ readModel = null } = {}) {
    this.readModel = readModel;
  }

  async emit(eventType, payload) {
    const envelope = {
      eventId: `evt_${uuidv7().replaceAll("-", "")}`,
      eventType,
      occurredAt: new Date().toISOString(),
      ...payload
    };
    // JSON line for ingest by log pipeline.
    console.log(`EVENT_JSON: ${JSON.stringify(envelope)}`);
    if (this.readModel) {
      try {
        await this.readModel.persistEvent(envelope);
      } catch (error) {
        console.error("read_model_persist_failed", error?.message || error);
      }
    }
    return envelope;
  }
}

module.exports = { EventBus };
