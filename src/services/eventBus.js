const { v7: uuidv7 } = require("uuid");

class EventBus {
  constructor({ producer = null, readModel = null } = {}) {
    this.producer = producer;
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
    // eslint-disable-next-line no-console
    console.log(`EVENT_JSON: ${JSON.stringify(envelope)}`);
    if (this.producer) {
      try {
        await this.producer.publish(envelope);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("event_publish_failed", error?.message || error);
      }
    }
    if (this.readModel) {
      try {
        await this.readModel.persistEvent(envelope);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("read_model_persist_failed", error?.message || error);
      }
    }
    return envelope;
  }
}

module.exports = { EventBus };
